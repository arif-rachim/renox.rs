// Versioned secret sets (docs/contracts/deploy-api.md section 9). Each PUT or
// DELETE creates the next version of the app's set; a row holds one value
// from version_from up to (excluding) version_to. Values are encrypted with
// the tenant's data key and never leave this module except in a node's
// secret bundle.

import { num, type Db } from "../db/db.ts";
import { invalid, notFound } from "../errors.ts";
import { decryptValue, encryptValue, newDek, valueAad, type KeyProvider } from "./crypto.ts";

/** deploy-api.md section 9. */
export const MAX_SECRETS = 100;
export const MIN_VALUE_BYTES = 8;
export const MAX_VALUE_BYTES = 65_536;

const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/** Refuses values the runtime would refuse (ops.md section 3) or that are over the cap. */
export function checkValue(value: string): void {
  if (byteLength(value) < MIN_VALUE_BYTES || [...value].length < MIN_VALUE_BYTES) throw invalid("value", "secret values are at least 8 bytes");
  if (byteLength(value) > MAX_VALUE_BYTES) throw invalid("value", "secret values are at most 64 KiB");
}

/** The tenant's data key, created and wrapped on first use. */
async function dekOf(tx: Db, keys: KeyProvider, tenantId: string, now: number): Promise<Uint8Array> {
  const rows = await tx.query<{ wrapped_dek: Uint8Array; nonce: Uint8Array }>("select wrapped_dek, nonce from tenant_keys where tenant_id = $1", [tenantId]);
  const row = rows[0];
  if (row !== undefined) return keys.unwrap(new Uint8Array(row.wrapped_dek), new Uint8Array(row.nonce), tenantId);
  const dek = newDek();
  const { wrapped, nonce } = await keys.wrap(dek, tenantId);
  const inserted = await tx.query(
    "insert into tenant_keys (tenant_id, wrapped_dek, nonce, master_key_id, created_at) values ($1, $2, $3, $4, $5) on conflict (tenant_id) do nothing returning tenant_id",
    [tenantId, wrapped, nonce, keys.id, now],
  );
  // A concurrent first write won: use its key.
  return inserted.length === 0 ? dekOf(tx, keys, tenantId, now) : dek;
}

/** Locks the app's set and returns the next version. */
async function nextVersion(tx: Db, tenantId: string, app: string): Promise<number> {
  const rows = await tx.query<{ version: number }>("update secret_sets set version = version + 1 where tenant_id = $1 and app = $2 returning version", [tenantId, app]);
  if (rows[0] === undefined) throw notFound();
  return Number(rows[0].version);
}

export async function putSecret(tx: Db, keys: KeyProvider, tenantId: string, app: string, name: string, value: string, now: number): Promise<number> {
  checkValue(value);
  const open = await tx.query<{ name: string }>("select name from secrets where tenant_id = $1 and app = $2 and version_to is null", [tenantId, app]);
  if (!open.some((r) => r.name === name) && open.length >= MAX_SECRETS) throw invalid("name", `an app has at most ${MAX_SECRETS} secrets`);
  const version = await nextVersion(tx, tenantId, app);
  await closeValue(tx, tenantId, app, name, version);
  const dek = await dekOf(tx, keys, tenantId, now);
  const { ciphertext, nonce } = encryptValue(dek, value, valueAad(tenantId, app, name, version));
  await tx.query(
    "insert into secrets (tenant_id, app, name, version_from, version_to, ciphertext, nonce, created_at) values ($1, $2, $3, $4, null, $5, $6, $7)",
    [tenantId, app, name, version, ciphertext, nonce, now],
  );
  return version;
}

/** Ends the open value of `name` at `version`. */
async function closeValue(tx: Db, tenantId: string, app: string, name: string, version: number): Promise<void> {
  await tx.query("update secrets set version_to = $2 where tenant_id = $1 and app = $3 and name = $4 and version_to is null", [tenantId, version, app, name]);
}

export async function deleteSecret(tx: Db, tenantId: string, app: string, name: string): Promise<number> {
  const open = await tx.query("select 1 from secrets where tenant_id = $1 and app = $2 and name = $3 and version_to is null", [tenantId, app, name]);
  if (open.length === 0) throw notFound();
  const version = await nextVersion(tx, tenantId, app);
  await closeValue(tx, tenantId, app, name, version);
  return version;
}

export async function listSecrets(db: Db, tenantId: string, app: string): Promise<{ version: number; secrets: { name: string; updated_at: number }[] }> {
  const version = await latestVersion(db, tenantId, app);
  const rows = await db.query<{ name: string; created_at: unknown }>(
    "select name, created_at from secrets where tenant_id = $1 and app = $2 and version_to is null order by name",
    [tenantId, app],
  );
  return { version, secrets: rows.map((r) => ({ name: r.name, updated_at: num(r.created_at) })) };
}

export async function latestVersion(db: Db, tenantId: string, app: string): Promise<number> {
  const rows = await db.query<{ version: number }>("select version from secret_sets where tenant_id = $1 and app = $2", [tenantId, app]);
  return Number(rows[0]?.version ?? 0);
}

/** Plaintext values of the set at `version`, limited to `names`. Only for a node's bundle. */
export async function valuesAt(db: Db, keys: KeyProvider, tenantId: string, app: string, version: number, names: readonly string[]): Promise<Record<string, string>> {
  if (names.length === 0) return {};
  const rows = await db.query<{ name: string; version_from: number; ciphertext: Uint8Array; nonce: Uint8Array }>(
    `select name, version_from, ciphertext, nonce from secrets
     where tenant_id = $1 and app = $2 and version_from <= $3 and (version_to is null or version_to > $3) and name = any($4::text[])
     order by name`,
    [tenantId, app, version, [...names]],
  );
  if (rows.length === 0) return {};
  const dek = await dekOf(db, keys, tenantId, 0);
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.name] = decryptValue(dek, new Uint8Array(r.ciphertext), new Uint8Array(r.nonce), valueAad(tenantId, app, r.name, Number(r.version_from)));
  }
  return out;
}
