// The module config the platform computes (docs/contracts/deploy-api.md 0.12
// sections 8 and 10; #818, #826): the email module's `app_url`, filled in
// when the active deployment's lock entry for `email` leaves it empty.

import type { Deps } from "../context.ts";
import type { Db } from "../db/db.ts";
import type { RouteEntry } from "./table.ts";

/** The app's `https://` origin: its only verified custom domain, else the platform hostname. */
async function primaryOrigin(tx: Db, deps: Deps, tenantId: string, app: string): Promise<string> {
  const rows = await tx.query<{ hostname: string }>("select hostname from domains where tenant_id = $1 and app = $2 and state = 'verified' order by hostname limit 2", [tenantId, app]);
  const host = rows.length === 1 ? (rows[0] as { hostname: string }).hostname : `${app}.${deps.config.platformDomain}`;
  return `https://${host}`;
}

/** `{ email: { app_url } }` when the manifest has the `email` module with `app_url` absent or empty; else undefined. */
export async function moduleConfigFor(tx: Db, deps: Deps, tenantId: string, app: string, manifest: unknown): Promise<RouteEntry["module_config"]> {
  const parsed = typeof manifest === "string" ? (JSON.parse(manifest) as unknown) : manifest;
  const modules = (parsed as { modules?: unknown } | null)?.modules;
  if (!Array.isArray(modules)) return undefined;
  const email = modules.find((m) => (m as { name?: unknown } | null)?.name === "email") as { config?: Record<string, unknown> | null } | undefined;
  if (email === undefined) return undefined;
  const url = email.config?.app_url;
  if (url !== undefined && url !== null && url !== "") return undefined;
  return { email: { app_url: await primaryOrigin(tx, deps, tenantId, app) } };
}

/** The stored manifest of a deployment, or null. */
export async function manifestOf(tx: Db, tenantId: string, app: string, hash: string): Promise<unknown> {
  const rows = await tx.query<{ manifest: unknown }>("select manifest from deployments where tenant_id = $1 and app = $2 and hash = $3", [tenantId, app, hash]);
  return rows[0]?.manifest ?? null;
}
