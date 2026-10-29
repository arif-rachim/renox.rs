// Certificate keys and PKCS#10 certificate signing requests for ACME
// finalize (RFC 8555 section 7.4; RFC 2986). node:crypto makes keys but not
// CSRs, so the few DER structures a CSR needs are encoded here.

import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One DER TLV. */
export const tlv = (tag: number, ...content: Uint8Array[]): Uint8Array => {
  const body = concat(content);
  return concat([Uint8Array.of(tag), len(body.length), body]);
};

const seq = (...c: Uint8Array[]): Uint8Array => tlv(0x30, ...c);
const set = (...c: Uint8Array[]): Uint8Array => tlv(0x31, ...c);

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const out = [40 * (parts[0] as number) + (parts[1] as number)];
  for (const p of parts.slice(2)) {
    const groups: number[] = [];
    for (let v = p; ; v = Math.floor(v / 128)) {
      groups.unshift(v % 128);
      if (v < 128) break;
    }
    out.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return tlv(0x06, Uint8Array.from(out));
}

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

const OID_CN = "2.5.4.3";
const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";

/** A new ECDSA P-256 key for one certificate. */
export function newCertificateKey(): KeyObject {
  return generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
}

/** The key as PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`, deploy-api.md `certificate_bundle`). */
export const keyPem = (key: KeyObject): string => key.export({ format: "pem", type: "pkcs8" }).toString();

/** A DER CSR for `hostname`: subject CN and one subjectAltName dNSName, signed with `key`. */
export function csrDer(key: KeyObject, hostname: string): Uint8Array {
  const spki = new Uint8Array(createPublicKey(key).export({ format: "der", type: "spki" }));
  const subject = seq(set(seq(oid(OID_CN), tlv(0x0c, ascii(hostname)))));
  const san = seq(tlv(0x82, ascii(hostname)));
  const extensions = seq(seq(oid(OID_SUBJECT_ALT_NAME), tlv(0x04, san)));
  const attributes = tlv(0xa0, seq(oid(OID_EXTENSION_REQUEST), set(extensions)));
  const info = seq(tlv(0x02, Uint8Array.of(0)), subject, spki, attributes);
  const signature = new Uint8Array(sign("sha256", info, { key, dsaEncoding: "der" }));
  return seq(info, seq(oid(OID_ECDSA_SHA256)), tlv(0x03, Uint8Array.of(0), signature));
}

export const b64url = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64url");
