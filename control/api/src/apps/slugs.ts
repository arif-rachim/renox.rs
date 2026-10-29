// App names are the `<app>.<platform domain>` slugs (#114;
// docs/24-threat-model.md section C, "Custom domain takeover"). Reserved
// words are never an app name, and a deleted app's name is quarantined for
// 90 days: only the tenant that deleted it may take it again, so nobody else
// inherits its links, cookies, or reputation.
//
// Both rules are enforced in the database (migrations/0005_domains_ownership.sql):
// a trigger skips the insert of a refused name, so `createApp` answers 409
// "not available", the same answer as for a name in use; another trigger
// quarantines the name of every deleted app. This module holds the list and
// the read side.

import type { Db } from "../db/db.ts";

/** The same list as `reserved_slugs()` in the migration (tests/domains-ownership.test.ts checks both agree). */
export const RESERVED_SLUGS: readonly string[] = [
  "www", "api", "app", "apps", "admin", "dashboard", "console", "mcp", "acme", "edge", "mail", "smtp", "imap", "pop", "mx",
  "ns", "ns1", "ns2", "dns", "cdn", "static", "assets", "status", "docs", "help", "support", "blog", "auth", "login", "sso",
  "id", "account", "accounts", "billing", "security", "abuse", "postmaster", "hostmaster", "webmaster", "root", "renox",
  "internal", "preview", "staging", "test", "dev", "localhost", "autodiscover", "autoconfig", "wpad",
];

/** How long a deleted app's name stays with its tenant. */
export const QUARANTINE_MS = 90 * 86_400_000;

export type SlugState = "available" | "reserved" | "quarantined";

/** Whether `tenantId` may create an app named `name` at `now` (ignoring names in use). */
export async function slugState(db: Db, name: string, tenantId: string, now: number): Promise<SlugState> {
  if (RESERVED_SLUGS.includes(name)) return "reserved";
  const rows = await db.query("select 1 from quarantined_slugs where slug = $1 and tenant_id <> $2 and until > $3", [name, tenantId, now]);
  return rows.length > 0 ? "quarantined" : "available";
}
