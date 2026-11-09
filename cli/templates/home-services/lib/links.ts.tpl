// Signed links for customers who do not log in: `/l/<kind>/<token>`.
// The token is 32 random bytes (base64url); the table keeps only its SHA-256,
// so a copy of the database opens nothing. No secret is involved: a link is
// valid because its hash is on file, before it expires and (for `approve`)
// until it is used once. A `report` link (the visit report, `/l/report/<token>`)
// and an `invoice` link (`/l/invoice/<token>`) open as often as the customer
// likes until they expire.
import type { DbStatements } from "@renoxium/sdk";

export type LinkKind = "approve" | "report" | "invoice";

type LinkRow = {
  ref_id: string;
  expires_at: number;
  used_at: number | null;
}

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

async function hashOf(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 (hex) the table stores for `token`. */
export const tokenHash = hashOf;

/** A new link for `refId`, valid for `ttlSeconds`; returns its path. The token cannot be recovered later. */
export async function issueLink(ctx: { db: DbStatements }, kind: LinkKind, refId: string, ttlSeconds: number): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  await ctx.db.execute("insert into app__links (token_hash, kind, ref_id, expires_at, used_at) values (?, ?, ?, ?, null)", [await hashOf(token), kind, refId, now + ttlSeconds]);
  return `/l/${kind}/${token}`;
}

export type LinkCheck = { state: "ok"; refId: string } | { state: "expired" | "used"; refId: string } | { state: "invalid" };

/** What the token opens: `invalid` (no such link: a 404), `expired`, `used` (an `approve` link is single use) or `ok`. */
export async function verifyLink(ctx: { db: DbStatements }, kind: LinkKind, token: unknown): Promise<LinkCheck> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return { state: "invalid" };
  const row = await ctx.db.queryOne<LinkRow>("select ref_id, expires_at, used_at from app__links where token_hash = ? and kind = ?", [await hashOf(token), kind]);
  if (row === null) return { state: "invalid" };
  if (kind === "approve" && row.used_at !== null) return { state: "used", refId: row.ref_id };
  if (row.expires_at <= Math.floor(Date.now() / 1000)) return { state: "expired", refId: row.ref_id };
  return { state: "ok", refId: row.ref_id };
}

/** Marks an `approve` link used; false when it already was (two submits at once: one wins). */
export async function consumeLink(ctx: { db: DbStatements }, token: string): Promise<boolean> {
  const r = await ctx.db.execute("update app__links set used_at = ? where token_hash = ? and used_at is null", [Math.floor(Date.now() / 1000), await hashOf(token)]);
  return r.changes === 1;
}
