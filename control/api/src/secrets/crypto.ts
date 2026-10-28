// Envelope encryption for secrets (docs/contracts/deploy-api.md section 9;
// docs/04-isolation-security.md "Secrets"): each tenant has a 256-bit data key
// (DEK), stored only wrapped by the master key; each value is encrypted with
// the DEK. AES-256-GCM everywhere, 96-bit random nonces, the 16-byte tag
// appended to the ciphertext.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const TAG = 16;

function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: new Uint8Array(body), nonce: new Uint8Array(nonce) };
}

function open(key: Uint8Array, ciphertext: Uint8Array, nonce: Uint8Array, aad: string): Uint8Array {
  if (ciphertext.length < TAG) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG));
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG)), decipher.final()]));
}

/** Wraps and unwraps data keys. The env master key today; a KMS adapter later (#120). */
export interface KeyProvider {
  /** Recorded with every wrapped key, for rotation. */
  readonly id: string;
  wrap(dek: Uint8Array, tenantId: string): Promise<{ wrapped: Uint8Array; nonce: Uint8Array }>;
  unwrap(wrapped: Uint8Array, nonce: Uint8Array, tenantId: string): Promise<Uint8Array>;
}

export class MasterKeyError extends Error {}

/** The master key from CONTROL_MASTER_KEY: 32 bytes, base64. */
export class EnvMasterKey implements KeyProvider {
  readonly id: string;
  private readonly key: Uint8Array;
  constructor(base64: string, id = "env-1") {
    const key = Buffer.from(base64, "base64");
    if (key.length !== 32) throw new MasterKeyError("CONTROL_MASTER_KEY must be 32 bytes, base64");
    this.key = new Uint8Array(key);
    this.id = id;
  }
  async wrap(dek: Uint8Array, tenantId: string) {
    const { ciphertext, nonce } = seal(this.key, dek, `dek\n${tenantId}`);
    return { wrapped: ciphertext, nonce };
  }
  async unwrap(wrapped: Uint8Array, nonce: Uint8Array, tenantId: string) {
    return open(this.key, wrapped, nonce, `dek\n${tenantId}`);
  }
}

export const newDek = (): Uint8Array => new Uint8Array(randomBytes(32));

/** The associated data that binds a ciphertext to its row. */
export const valueAad = (tenantId: string, app: string, name: string, version: number): string => `${tenantId}\n${app}\n${name}\n${version}`;

export function encryptValue(dek: Uint8Array, value: string, aad: string): { ciphertext: Uint8Array; nonce: Uint8Array } {
  return seal(dek, Buffer.from(value, "utf8"), aad);
}

export function decryptValue(dek: Uint8Array, ciphertext: Uint8Array, nonce: Uint8Array, aad: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(open(dek, ciphertext, nonce, aad));
}
