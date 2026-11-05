// The re-seal job of a master key rotation (#451; ops/security/keys.md,
// "Master key"): every stored value whose key id is not the current master
// key's is opened (with the key its id names, or for a value from before ids
// the current key and then the previous one) and sealed again under the
// current key.
//
// | Kind | Table and columns | What is sealed |
// | --- | --- | --- |
// | `tenant_key` | `tenant_keys.wrapped_dek`, `nonce`, `master_key_id` | the tenant's data key; the secret values under it are not touched |
// | `totp` | `account_mfa_totp.secret_sealed`, `secret_key_id` | a TOTP secret |
// | `callback_token` | `workers.callback_token_wrapped`, `callback_token_nonce`, `callback_token_key_id` | a node's callback token |
//
// The rules:
// - In batches (`BATCH` rows per query), ordered by the row's key, with a
//   cursor, so a row that cannot be opened is counted once and never loops.
// - One guarded `UPDATE` per row: the new ciphertext and the new id together,
//   only while the row still holds the id and the ciphertext the job read.
//   A crash between two rows leaves every row either as it was or moved,
//   and both open; the next run finishes (the job is idempotent).
// - A value from before ids that already opens under the current key is only
//   re-tagged with the current id: same ciphertext.
// - It logs counts only. A value, a key or a ciphertext never reaches a log
//   line, an error or the report; an unreadable row is named by its row key
//   (a tenant id, a user id, a node id) only.

import { MasterKeyProvider } from "./crypto.ts";
import { masterKeys, type MasterKeys } from "./master.ts";
import { openTotp, sealTotp, totpKey } from "../auth/mfa.ts";
import type { Db } from "../db/db.ts";
import type { Deps } from "../context.ts";

export type Kind = "tenant_key" | "totp" | "callback_token";
export const KINDS: readonly Kind[] = ["tenant_key", "totp", "callback_token"];

/** Rows per query. */
export const BATCH = 200;

export interface KindReport {
  /** Opened under another key and sealed again under the current one. */
  resealed: number;
  /** From before ids, already under the current key: only the id was written. */
  retagged: number;
  /** Changed by someone else between the read and the write: left for the next run. */
  raced: number;
  /** Opens under no configured key (row keys only). */
  unreadable: string[];
  /** Still under another key after this run. */
  remaining: number;
}

export type ResealReport = Record<Kind, KindReport>;

export interface ResealOptions {
  batch?: number;
  /** Tests: called before each write; a throw stops the job there (a crash). */
  beforeWrite?: (kind: Kind, rowKey: string) => void;
}

/** Values still under a key other than the current one, per kind (0 each without a master key). */
export async function remainingOtherKey(db: Db, keys: MasterKeys | null): Promise<Record<Kind, number>> {
  if (keys === null) return { tenant_key: 0, totp: 0, callback_token: 0 };
  const id = keys.current.id;
  const count = async (sql: string): Promise<number> => Number((await db.query<{ n: unknown }>(sql, [id]))[0]?.n ?? 0);
  return {
    tenant_key: await count("select count(*) as n from tenant_keys where master_key_id is distinct from $1"),
    totp: await count("select count(*) as n from account_mfa_totp where secret_key_id is distinct from $1"),
    callback_token: await count("select count(*) as n from workers where callback_token_wrapped is not null and callback_token_key_id is distinct from $1"),
  };
}

const empty = (): KindReport => ({ resealed: 0, retagged: 0, raced: 0, unreadable: [], remaining: 0 });

async function tenantKeys(db: Db, keys: MasterKeys, report: KindReport, opts: ResealOptions): Promise<void> {
  const provider = new MasterKeyProvider(keys);
  const current = keys.current.id;
  let after = "";
  for (;;) {
    const rows = await db.query<{ tenant_id: string; wrapped_dek: Uint8Array; nonce: Uint8Array; master_key_id: string }>(
      "select tenant_id, wrapped_dek, nonce, master_key_id from tenant_keys where master_key_id is distinct from $1 and tenant_id > $2 order by tenant_id limit $3",
      [current, after, opts.batch ?? BATCH],
    );
    if (rows.length === 0) return;
    for (const r of rows) {
      after = r.tenant_id;
      const wrapped = new Uint8Array(r.wrapped_dek);
      let opened: { plain: Uint8Array; keyId: string };
      try {
        opened = await provider.unwrapWithId(wrapped, new Uint8Array(r.nonce), r.tenant_id, r.master_key_id);
      } catch {
        report.unreadable.push(r.tenant_id);
        continue;
      }
      opts.beforeWrite?.("tenant_key", r.tenant_id);
      const next = opened.keyId === current ? { wrapped, nonce: new Uint8Array(r.nonce) } : await provider.wrap(opened.plain, r.tenant_id);
      opened.plain.fill(0);
      const done = await db.query(
        "update tenant_keys set wrapped_dek = $1, nonce = $2, master_key_id = $3 where tenant_id = $4 and master_key_id = $5 and wrapped_dek = $6 returning tenant_id",
        [next.wrapped, next.nonce, current, r.tenant_id, r.master_key_id, wrapped],
      );
      if (done.length === 0) report.raced++;
      else if (opened.keyId === current) report.retagged++;
      else report.resealed++;
    }
  }
}

async function totpSecrets(db: Db, keys: MasterKeys, report: KindReport, opts: ResealOptions): Promise<void> {
  const current = keys.current;
  const currentKey = totpKey(current);
  let after = "";
  for (;;) {
    const rows = await db.query<{ user_id: string; secret_sealed: string; secret_key_id: string | null }>(
      "select user_id, secret_sealed, secret_key_id from account_mfa_totp where secret_key_id is distinct from $1 and user_id > $2 order by user_id limit $3",
      [current.id, after, opts.batch ?? BATCH],
    );
    if (rows.length === 0) return;
    for (const r of rows) {
      after = r.user_id;
      let secret: string | null = null;
      let openedBy: string | null = null;
      for (const k of keys.forId(r.secret_key_id)) {
        secret = openTotp(totpKey(k), r.user_id, r.secret_sealed);
        if (secret !== null) {
          openedBy = k.id;
          break;
        }
      }
      if (secret === null || openedBy === null) {
        report.unreadable.push(r.user_id);
        continue;
      }
      opts.beforeWrite?.("totp", r.user_id);
      const sealed = openedBy === current.id ? r.secret_sealed : sealTotp(currentKey, r.user_id, secret);
      const done = await db.query(
        "update account_mfa_totp set secret_sealed = $1, secret_key_id = $2 where user_id = $3 and secret_key_id is not distinct from $4 and secret_sealed = $5 returning user_id",
        [sealed, current.id, r.user_id, r.secret_key_id, r.secret_sealed],
      );
      if (done.length === 0) report.raced++;
      else if (openedBy === current.id) report.retagged++;
      else report.resealed++;
    }
  }
}

async function callbackTokens(db: Db, keys: MasterKeys, report: KindReport, opts: ResealOptions): Promise<void> {
  const provider = new MasterKeyProvider(keys);
  const current = keys.current.id;
  let after = "";
  for (;;) {
    const rows = await db.query<{ node_id: string; callback_token_wrapped: Uint8Array; callback_token_nonce: Uint8Array; callback_token_key_id: string | null }>(
      `select node_id, callback_token_wrapped, callback_token_nonce, callback_token_key_id from workers
       where callback_token_wrapped is not null and callback_token_nonce is not null and callback_token_key_id is distinct from $1 and node_id > $2
       order by node_id limit $3`,
      [current, after, opts.batch ?? BATCH],
    );
    if (rows.length === 0) return;
    for (const r of rows) {
      after = r.node_id;
      const wrapped = new Uint8Array(r.callback_token_wrapped);
      const subject = `node:${r.node_id}`;
      let opened: { plain: Uint8Array; keyId: string };
      try {
        opened = await provider.unwrapWithId(wrapped, new Uint8Array(r.callback_token_nonce), subject, r.callback_token_key_id);
      } catch {
        report.unreadable.push(r.node_id);
        continue;
      }
      opts.beforeWrite?.("callback_token", r.node_id);
      const next = opened.keyId === current ? { wrapped, nonce: new Uint8Array(r.callback_token_nonce) } : await provider.wrap(opened.plain, subject);
      opened.plain.fill(0);
      const done = await db.query(
        `update workers set callback_token_wrapped = $1, callback_token_nonce = $2, callback_token_key_id = $3
         where node_id = $4 and callback_token_key_id is not distinct from $5 and callback_token_wrapped = $6 returning node_id`,
        [next.wrapped, next.nonce, current, r.node_id, r.callback_token_key_id, wrapped],
      );
      if (done.length === 0) report.raced++;
      else if (opened.keyId === current) report.retagged++;
      else report.resealed++;
    }
  }
}

/**
 * One run over every kind. Without a master key there is nothing to do and
 * the report is all zeros. Logs one `reseal` line with the counts.
 */
export async function reseal(deps: Pick<Deps, "db" | "config" | "log">, opts: ResealOptions = {}): Promise<ResealReport> {
  const keys = masterKeys(deps);
  const report: ResealReport = { tenant_key: empty(), totp: empty(), callback_token: empty() };
  if (keys === null) return report;
  await tenantKeys(deps.db, keys, report.tenant_key, opts);
  await totpSecrets(deps.db, keys, report.totp, opts);
  await callbackTokens(deps.db, keys, report.callback_token, opts);
  const left = await remainingOtherKey(deps.db, keys);
  for (const k of KINDS) report[k].remaining = left[k];
  deps.log.info("reseal", {
    key_id: keys.current.id,
    previous_key_id: keys.previous?.id ?? null,
    ...Object.fromEntries(KINDS.map((k) => [k, { resealed: report[k].resealed, retagged: report[k].retagged, raced: report[k].raced, unreadable: report[k].unreadable.length, remaining: report[k].remaining }])),
  });
  return report;
}

/**
 * The one JSON line `bun control/api/scripts/reseal.ts` prints, and its exit
 * code: 0 when nothing is left under another key and nothing is unreadable,
 * 1 otherwise (run it again, or investigate the named rows). Counts and row
 * keys only.
 */
export function summary(keys: MasterKeys | null, report: ResealReport): { line: string; exitCode: number } {
  const left = KINDS.reduce((n, k) => n + report[k].remaining, 0);
  const unreadable = KINDS.reduce((n, k) => n + report[k].unreadable.length, 0);
  const line = JSON.stringify({
    reseal: keys === null ? "no master key" : left === 0 && unreadable === 0 ? "done" : "not done",
    key_id: keys?.current.id ?? null,
    previous_key_id: keys?.previous?.id ?? null,
    remaining: left,
    ...report,
  });
  return { line, exitCode: left === 0 && unreadable === 0 ? 0 : 1 };
}
