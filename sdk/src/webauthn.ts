// WebAuthn verification (W3C Web Authentication Level 2) for passkeys: the
// `2fa` module (#287), the `auth` passkey sign-in (#291) and control-plane
// MFA (#293). One implementation on Web Crypto (#284).
//
// Registration (`navigator.credentials.create`): the client data's type,
// challenge and origin, the RP id hash, the user-present (and, when asked,
// user-verified) flags, the attested credential, and the attestation
// statement of the `none` and `packed` self-attestation formats (formats
// with a certificate chain are refused: there is no trust store here).
// Assertion (`navigator.credentials.get`): the same checks, the signature
// over authenticatorData || SHA-256(clientDataJSON) with the stored COSE
// key (ES256 or RS256), and the signature counter, which must grow unless
// both are 0 (a counter that does not grow means a cloned authenticator).
//
// Binary values cross as base64url strings, as the browser JSON
// serialisation (PublicKeyCredential.toJSON) gives them.

import { timingSafeEqual } from "./crypto.ts";

const enc = new TextEncoder();
/** Web Crypto takes ArrayBuffer-backed views; ours always are. */
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => u as Uint8Array<ArrayBuffer>;

const dec = new TextDecoder();

/** Why a registration or an assertion was refused. */
export class WebAuthnError extends Error {
  override readonly name = "WebAuthnError";
  constructor(
    readonly reason:
      | "client_data"
      | "type"
      | "challenge"
      | "origin"
      | "rp_id"
      | "user_presence"
      | "user_verification"
      | "credential"
      | "attestation"
      | "algorithm"
      | "signature"
      | "counter",
    message: string,
  ) {
    super(message);
  }
}

export type Binary = string | ArrayBuffer | Uint8Array;

/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** base64url (or base64) to bytes. */
export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const bytesOf = (v: Binary): Uint8Array => (typeof v === "string" ? fromBase64url(v) : v instanceof Uint8Array ? v : new Uint8Array(v));

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(b)));
}

/** Constant time (crypto.ts): challenges and RP id hashes are secrets of the ceremony. */
const equal = (a: Uint8Array, b: Uint8Array): boolean => timingSafeEqual(a, b);

// --- CBOR (RFC 8949), the subset WebAuthn uses --------------------------------

type Cbor = number | bigint | string | Uint8Array | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

/** Decodes one CBOR item at `at`; returns it and the offset after it. */
export function decodeCbor(b: Uint8Array, at = 0): [Cbor, number] {
  const head = b[at];
  if (head === undefined) throw new WebAuthnError("credential", "CBOR: truncated");
  const major = head >> 5;
  const info = head & 31;
  let i = at + 1;
  let n: number;
  if (info < 24) n = info;
  else if (info === 24) n = b[i++] as number;
  else if (info === 25) {
    n = ((b[i] as number) << 8) | (b[i + 1] as number);
    i += 2;
  } else if (info === 26) {
    n = new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0);
    i += 4;
  } else if (info === 27) {
    const big = new DataView(b.buffer, b.byteOffset + i, 8).getBigUint64(0);
    n = Number(big);
    i += 8;
  } else throw new WebAuthnError("credential", "CBOR: indefinite lengths are not supported");
  switch (major) {
    case 0:
      return [n, i];
    case 1:
      return [-1 - n, i];
    case 2:
      if (i + n > b.length) throw new WebAuthnError("credential", "CBOR: truncated byte string");
      return [b.slice(i, i + n), i + n];
    case 3:
      if (i + n > b.length) throw new WebAuthnError("credential", "CBOR: truncated text");
      return [dec.decode(b.subarray(i, i + n)), i + n];
    case 4: {
      const arr: Cbor[] = [];
      for (let k = 0; k < n; k++) {
        const [v, next] = decodeCbor(b, i);
        arr.push(v);
        i = next;
      }
      return [arr, i];
    }
    case 5: {
      const map = new Map<Cbor, Cbor>();
      for (let k = 0; k < n; k++) {
        const [key, a] = decodeCbor(b, i);
        const [v, next] = decodeCbor(b, a);
        map.set(key, v);
        i = next;
      }
      return [map, i];
    }
    case 7:
      if (info === 20) return [false, i];
      if (info === 21) return [true, i];
      if (info === 22) return [null, i];
      return [undefined, i];
    default:
      throw new WebAuthnError("credential", `CBOR: major type ${major} is not supported`);
  }
}

// --- COSE keys (RFC 9053): ES256 and RS256 ------------------------------------

export const COSE_ES256 = -7;
export const COSE_RS256 = -257;

async function importCose(cose: Uint8Array): Promise<{ key: CryptoKey; alg: number }> {
  const [m] = decodeCbor(cose);
  if (!(m instanceof Map)) throw new WebAuthnError("credential", "the credential public key is not a COSE map");
  const kty = m.get(1);
  const alg = m.get(3);
  if (kty === 2 && alg === COSE_ES256 && m.get(-1) === 1) {
    const x = m.get(-2);
    const y = m.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw new WebAuthnError("credential", "ES256 key: bad coordinates");
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: base64url(x), y: base64url(y), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return { key, alg };
  }
  if (kty === 3 && alg === COSE_RS256) {
    const n = m.get(-1);
    const e = m.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256) throw new WebAuthnError("credential", "RS256 key: bad modulus or exponent");
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: base64url(n), e: base64url(e), alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return { key, alg };
  }
  throw new WebAuthnError("algorithm", `unsupported COSE key (kty ${String(kty)}, alg ${String(alg)}); ES256 and RS256 are accepted`);
}

/** An ECDSA DER signature (WebAuthn's) to the raw r || s Web Crypto takes. */
function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  if (der[0] !== 0x30) throw new WebAuthnError("signature", "ES256 signature is not DER");
  let i = 2;
  const int = (): Uint8Array => {
    if (der[i] !== 0x02) throw new WebAuthnError("signature", "ES256 signature is not DER");
    const len = der[i + 1] as number;
    let v = der.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new WebAuthnError("signature", "ES256 signature integer too long");
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = int();
  const s = int();
  const raw = new Uint8Array(size * 2);
  raw.set(r);
  raw.set(s, size);
  return raw;
}

async function verifySignature(cose: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const { key, alg } = await importCose(cose);
  if (alg === COSE_ES256) return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, buf(derToRaw(signature)), buf(data));
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, buf(signature), buf(data));
}

// --- authenticator data ------------------------------------------------------

interface AuthData {
  rpIdHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  counter: number;
  credentialId?: Uint8Array;
  publicKey?: Uint8Array;
}

function parseAuthData(b: Uint8Array): AuthData {
  if (b.length < 37) throw new WebAuthnError("credential", "authenticator data is too short");
  const flags = b[32] as number;
  const out: AuthData = {
    rpIdHash: b.slice(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    counter: new DataView(b.buffer, b.byteOffset + 33, 4).getUint32(0),
  };
  if (flags & 0x40) {
    // Attested credential data: aaguid (16), credentialIdLength (2), id, COSE key.
    const len = ((b[53] as number) << 8) | (b[54] as number);
    out.credentialId = b.slice(55, 55 + len);
    const [, end] = decodeCbor(b, 55 + len);
    out.publicKey = b.slice(55 + len, end);
  }
  return out;
}

interface Expected {
  /** The challenge the server issued, base64url. */
  expectedChallenge: string;
  /** The page origin(s) the ceremony may come from (`https://shop.example`). */
  expectedOrigin: string | readonly string[];
  /** The relying party id (the host, or a registrable suffix of it). */
  expectedRpId: string;
  /** Require the UV flag (a PIN or biometric, not only presence). */
  requireUserVerification?: boolean;
}

async function checkClientData(raw: Uint8Array, type: "webauthn.create" | "webauthn.get", o: Expected): Promise<void> {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    c = JSON.parse(dec.decode(raw)) as typeof c;
  } catch {
    throw new WebAuthnError("client_data", "clientDataJSON is not JSON");
  }
  if (c.type !== type) throw new WebAuthnError("type", `clientData.type is ${String(c.type)}, expected ${type}`);
  if (typeof c.challenge !== "string" || !equal(fromBase64url(c.challenge), fromBase64url(o.expectedChallenge))) {
    throw new WebAuthnError("challenge", "the challenge does not match");
  }
  const origins = typeof o.expectedOrigin === "string" ? [o.expectedOrigin] : o.expectedOrigin;
  if (typeof c.origin !== "string" || !origins.includes(c.origin)) throw new WebAuthnError("origin", `origin ${String(c.origin)} is not expected`);
}

async function checkAuthData(a: AuthData, o: Expected): Promise<void> {
  if (!equal(a.rpIdHash, await sha256(enc.encode(o.expectedRpId)))) throw new WebAuthnError("rp_id", "the RP id hash does not match");
  if (!a.userPresent) throw new WebAuthnError("user_presence", "the user was not present");
  if (o.requireUserVerification && !a.userVerified) throw new WebAuthnError("user_verification", "the user was not verified");
}

/** What to store for a new credential. */
export interface RegisteredCredential {
  /** base64url; the `id` the browser sends back in assertions. */
  credentialId: string;
  /** The COSE public key, base64url. */
  publicKey: string;
  /** -7 (ES256) or -257 (RS256). */
  algorithm: number;
  counter: number;
  userVerified: boolean;
  attestationFormat: string;
}

/** Verifies `navigator.credentials.create()`'s response. */
export async function verifyRegistration(o: Expected & { response: { clientDataJSON: Binary; attestationObject: Binary } }): Promise<RegisteredCredential> {
  const clientData = bytesOf(o.response.clientDataJSON);
  await checkClientData(clientData, "webauthn.create", o);
  const [att] = decodeCbor(bytesOf(o.response.attestationObject));
  if (!(att instanceof Map)) throw new WebAuthnError("attestation", "attestationObject is not a CBOR map");
  const fmt = att.get("fmt");
  const authBytes = att.get("authData");
  const stmt = att.get("attStmt");
  if (typeof fmt !== "string" || !(authBytes instanceof Uint8Array) || !(stmt instanceof Map)) throw new WebAuthnError("attestation", "attestationObject lacks fmt, authData or attStmt");
  const auth = parseAuthData(authBytes);
  await checkAuthData(auth, o);
  if (!auth.credentialId || !auth.publicKey) throw new WebAuthnError("credential", "no attested credential data");
  const { alg } = await importCose(auth.publicKey);
  if (fmt === "packed") {
    if (stmt.has("x5c")) throw new WebAuthnError("attestation", "packed attestation with a certificate chain is not supported");
    const sig = stmt.get("sig");
    if (stmt.get("alg") !== alg || !(sig instanceof Uint8Array)) throw new WebAuthnError("attestation", "packed self attestation: alg or sig");
    const data = new Uint8Array([...authBytes, ...(await sha256(clientData))]);
    if (!(await verifySignature(auth.publicKey, sig, data))) throw new WebAuthnError("signature", "the attestation signature does not verify");
  } else if (fmt !== "none") {
    throw new WebAuthnError("attestation", `attestation format ${fmt} is not supported (none and packed self attestation are)`);
  }
  return {
    credentialId: base64url(auth.credentialId),
    publicKey: base64url(auth.publicKey),
    algorithm: alg,
    counter: auth.counter,
    userVerified: auth.userVerified,
    attestationFormat: fmt,
  };
}

/** Verifies `navigator.credentials.get()`'s response against a stored credential; resolves with the counter to store. */
export async function verifyAssertion(
  o: Expected & {
    response: { clientDataJSON: Binary; authenticatorData: Binary; signature: Binary };
    credential: { publicKey: string; counter: number };
  },
): Promise<{ counter: number; userVerified: boolean }> {
  const clientData = bytesOf(o.response.clientDataJSON);
  await checkClientData(clientData, "webauthn.get", o);
  const authBytes = bytesOf(o.response.authenticatorData);
  const auth = parseAuthData(authBytes);
  await checkAuthData(auth, o);
  const data = new Uint8Array([...authBytes, ...(await sha256(clientData))]);
  if (!(await verifySignature(fromBase64url(o.credential.publicKey), bytesOf(o.response.signature), data))) {
    throw new WebAuthnError("signature", "the assertion signature does not verify");
  }
  if ((auth.counter !== 0 || o.credential.counter !== 0) && auth.counter <= o.credential.counter) {
    throw new WebAuthnError("counter", `the signature counter did not grow (${auth.counter} after ${o.credential.counter}): a replay or a cloned authenticator`);
  }
  return { counter: auth.counter, userVerified: auth.userVerified };
}

/** A random challenge (32 bytes, base64url) for a ceremony; store it with the session. */
export function webauthnChallenge(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
