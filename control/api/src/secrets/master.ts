// The master keys (#451; docs/contracts/deploy-api.md section 9;
// ops/security/keys.md, "Master key"): `CONTROL_MASTER_KEY` (current) and,
// during a rotation, `CONTROL_MASTER_KEY_PREVIOUS` (the key being retired).
//
// Every value stored sealed under the master key records the id of the key
// that sealed it: `tenant_keys.master_key_id`, `account_mfa_totp.secret_key_id`
// and `workers.callback_token_key_id` (migration 0032). New values are sealed
// under the current key. A value opens with the key its id names; a value
// from before ids existed (`env-1`, the only id the API ever wrote, or no id)
// tries the current key, then the previous one. AES-256-GCM refuses a wrong
// key, so trying both is a check, not a guess. The re-seal job
// (src/secrets/reseal.ts) moves every value to the current key; the operator
// unsets the previous key when `renox_cp_sealed_values_other_key` is 0.
//
// A key id is `mk-` and the first 16 hex characters of the key's SHA-256: it
// names the key without revealing it, and the key itself is never stored.

import { createHash } from "node:crypto";
import type { Config } from "../config.ts";

export interface MasterKey {
  /** `mk-<16 hex>`. */
  readonly id: string;
  /** The 32 bytes. */
  readonly key: Buffer;
  /** The base64 text of the environment variable (the HMAC key of export URLs, src/tenants/backups.ts). */
  readonly text: string;
}

/** The id the API wrote into `tenant_keys.master_key_id` before key ids (#451). */
export const LEGACY_KEY_ID = "env-1";

export class MasterKeyConfigError extends Error {}

/** `mk-` + 16 hex characters of SHA-256 of the key's bytes. */
export function keyIdOf(key: Uint8Array): string {
  return `mk-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** Decodes one key variable: 32 bytes, base64. The message names the variable, never the value. */
export function decodeMasterKey(name: string, text: string): MasterKey {
  const key = Buffer.from(text, "base64");
  if (key.length !== 32) throw new MasterKeyConfigError(`${name} must be 32 bytes, base64`);
  return { id: keyIdOf(key), key, text };
}

export class MasterKeys {
  constructor(
    readonly current: MasterKey,
    readonly previous: MasterKey | null,
  ) {}

  /** The keys to try for a value sealed under `id`, in order. An unknown id tries none. */
  forId(id: string | null | undefined): MasterKey[] {
    if (id === this.current.id) return [this.current];
    if (this.previous !== null && id === this.previous.id) return [this.previous];
    if (id === null || id === undefined || id === LEGACY_KEY_ID) return this.previous === null ? [this.current] : [this.current, this.previous];
    return [];
  }

  /** Every configured key, current first. */
  all(): MasterKey[] {
    return this.previous === null ? [this.current] : [this.current, this.previous];
  }
}

/**
 * Builds the pair from the configuration's text values. Refused (a
 * `MasterKeyConfigError`, exit 78 at start): a previous key without a current
 * one, a previous key equal to the current one, a key that is not 32 bytes.
 */
export function masterKeysFrom(current: string | null, previous: string | null | undefined): MasterKeys | null {
  if (current === null) {
    if (previous !== null && previous !== undefined) throw new MasterKeyConfigError("CONTROL_MASTER_KEY_PREVIOUS is set without CONTROL_MASTER_KEY");
    return null;
  }
  const cur = decodeMasterKey("CONTROL_MASTER_KEY", current);
  if (previous === null || previous === undefined) return new MasterKeys(cur, null);
  const prev = decodeMasterKey("CONTROL_MASTER_KEY_PREVIOUS", previous);
  if (prev.id === cur.id) throw new MasterKeyConfigError("CONTROL_MASTER_KEY_PREVIOUS is the same key as CONTROL_MASTER_KEY");
  return new MasterKeys(cur, prev);
}

const cache = new WeakMap<object, { current: string | null; previous: string | null; keys: MasterKeys | null }>();

/** The process's master keys, or null when `CONTROL_MASTER_KEY` is unset. Follows the configuration object. */
export function masterKeys(deps: { config: Pick<Config, "masterKey" | "masterKeyPrevious"> }): MasterKeys | null {
  const current = deps.config.masterKey;
  const previous = deps.config.masterKeyPrevious ?? null;
  const hit = cache.get(deps);
  if (hit !== undefined && hit.current === current && hit.previous === previous) return hit.keys;
  const keys = masterKeysFrom(current, previous);
  cache.set(deps, { current, previous, keys });
  return keys;
}
