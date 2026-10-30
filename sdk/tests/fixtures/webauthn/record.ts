// Writes webauthn.json next to this file: registrations and assertions made
// the way an authenticator makes them (CBOR attestation objects, COSE keys,
// DER ECDSA signatures), for sdk/tests/webauthn.test.ts. Run once:
//   bun sdk/tests/fixtures/webauthn/record.ts
// The private keys are thrown away; only the public data is recorded.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const enc = new TextEncoder();
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const sha256 = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

type C = number | string | Uint8Array | C[] | Map<C, C>;
function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function cbor(v: C): number[] {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = enc.encode(v);
    return [...head(3, b.length), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  if (Array.isArray(v)) return [...head(4, v.length), ...v.flatMap(cbor)];
  return [...head(5, v.size), ...[...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)])];
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array): number[] => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    const v = [...x.subarray(i)];
    if ((v[0] as number) & 0x80) v.unshift(0);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

const RP_ID = "shop.example";
const ORIGIN = "https://shop.example";

async function authData(counter: number, cred?: { id: Uint8Array; cose: Uint8Array }): Promise<Uint8Array> {
  const flags = 0x01 | 0x04 | (cred ? 0x40 : 0);
  const out = [...(await sha256(enc.encode(RP_ID))), flags, (counter >>> 24) & 255, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255];
  if (cred) out.push(...new Uint8Array(16), cred.id.length >> 8, cred.id.length & 255, ...cred.id, ...cred.cose);
  return new Uint8Array(out);
}

const clientData = (type: string, challenge: string): Uint8Array => enc.encode(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));

async function es256(fmt: "none" | "packed") {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const cose = new Uint8Array(cbor(new Map<C, C>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x as string, "base64url")], [-3, Buffer.from(jwk.y as string, "base64url")]])));
  const sign = async (data: Uint8Array) => rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, data)));
  return { cose, sign, fmt };
}

async function rs256() {
  const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const cose = new Uint8Array(cbor(new Map<C, C>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n as string, "base64url")], [-2, Buffer.from(jwk.e as string, "base64url")]])));
  const sign = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, data));
  return { cose, sign, fmt: "none" as const };
}

async function record(key: { cose: Uint8Array; sign: (d: Uint8Array) => Promise<Uint8Array>; fmt: "none" | "packed" }, alg: number) {
  const id = crypto.getRandomValues(new Uint8Array(16));
  const regChallenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const regData = clientData("webauthn.create", regChallenge);
  const regAuth = await authData(0, { id, cose: key.cose });
  const attStmt =
    key.fmt === "packed"
      ? new Map<C, C>([["alg", alg], ["sig", await key.sign(new Uint8Array([...regAuth, ...(await sha256(regData))]))]])
      : new Map<C, C>();
  const attestationObject = new Uint8Array(cbor(new Map<C, C>([["fmt", key.fmt], ["attStmt", attStmt], ["authData", regAuth]])));
  const getChallenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const getData = clientData("webauthn.get", getChallenge);
  const getAuth = await authData(1);
  const signature = await key.sign(new Uint8Array([...getAuth, ...(await sha256(getData))]));
  return {
    registration: { challenge: regChallenge, response: { clientDataJSON: b64u(regData), attestationObject: b64u(attestationObject) } },
    assertion: { challenge: getChallenge, response: { clientDataJSON: b64u(getData), authenticatorData: b64u(getAuth), signature: b64u(signature) } },
    credentialId: b64u(id),
  };
}

const out = {
  rpId: RP_ID,
  origin: ORIGIN,
  es256: await record(await es256("none"), -7),
  es256Packed: await record(await es256("packed"), -7),
  rs256: await record(await rs256(), -257),
};
writeFileSync(join(import.meta.dir, "webauthn.json"), `${JSON.stringify(out, null, 2)}\n`);
