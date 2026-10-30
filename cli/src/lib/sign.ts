// Module signatures (docs/contracts/manifest.md 1.2, section 5, "Registry
// modules"; #323): Ed25519 over `renox-module-v1\n<publisher>/<name>@<version>\n<hash>\n`,
// where <hash> is the module tree hash without `module.sig` itself.

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

import { hashFiles, readTree } from "./hash.ts";

export const SIG_FILE = "module.sig";

export interface ModuleSig {
  version: 1;
  publisher: string;
  key_id: string;
  name: string;
  module_version: string;
  hash: string;
  signature: string;
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** The tree hash a signature covers: every file but `module.sig`. */
export function signedTreeHash(tree: string): string {
  const files = readTree(tree);
  files.delete(SIG_FILE);
  return hashFiles(files);
}

export function signedMessage(publisher: string, name: string, version: string, hash: string): Uint8Array {
  return new TextEncoder().encode(`renox-module-v1\n${publisher}/${name}@${version}\n${hash}\n`);
}

/** A private key from PEM (PKCS#8) or base64url PKCS#8 DER. */
export function privateKey(text: string): KeyObject {
  const t = text.trim();
  if (t.startsWith("-----BEGIN")) return createPrivateKey(t);
  return createPrivateKey({ key: Buffer.from(t, "base64url"), format: "der", type: "pkcs8" });
}

/** `ed25519:<base64url of the raw 32-byte public key>`. */
export function keyIdOf(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  const jwk = pub.export({ format: "jwk" }) as { x?: string };
  if (jwk.x === undefined) throw new Error("not an Ed25519 key");
  return `ed25519:${jwk.x}`;
}

function publicKeyOf(keyId: string): KeyObject {
  const x = keyId.replace(/^ed25519:/u, "");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

export function signTree(tree: string, publisher: string, name: string, version: string, key: KeyObject): ModuleSig {
  const hash = signedTreeHash(tree);
  const signature = b64url(edSign(null, signedMessage(publisher, name, version, hash), key));
  return { version: 1, publisher, key_id: keyIdOf(key), name, module_version: version, hash, signature };
}

/** MF15: whether `sig` signs `hash` for this module with `sig.key_id`. */
export function verifySig(sig: ModuleSig, hash: string): boolean {
  if (sig.hash !== hash) return false;
  try {
    return edVerify(null, signedMessage(sig.publisher, sig.name, sig.module_version, hash), publicKeyOf(sig.key_id), Buffer.from(sig.signature, "base64url"));
  } catch {
    return false;
  }
}
