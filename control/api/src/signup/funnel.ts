// The activation funnel for the operator console (#326; docs/19-platform-
// wireframes.md section 1: sign-up to first deploy within 10 minutes).
// Tenants created in [from, to): how many verified the owner's address,
// created an app, and deployed, and how many deployed within 10 minutes of
// sign-up, with the median time to the first deploy. Counts only; no
// address or name leaves this function.
//
//   CONTROL_DATABASE_URL=postgres://… bun control/api/src/signup/funnel.ts [--days 30]

import type { Db } from "../db/db.ts";
import { num } from "../db/db.ts";

export const ACTIVATION_MS = 10 * 60_000;

export interface Funnel {
  from: number;
  to: number;
  signed_up: number;
  verified: number;
  created_app: number;
  deployed: number;
  deployed_within_10_min: number;
  /** Median sign-up to first deploy, ms, over the tenants that deployed; null when none did. */
  median_to_first_deploy_ms: number | null;
}

export async function funnel(db: Db, from: number, to: number): Promise<Funnel> {
  const rows = await db.query<Record<string, unknown>>(
    `select t.id, t.created_at,
       (select min(u.email_verified_at) from memberships m join users u on u.id = m.user_id where m.tenant_id = t.id and m.role = 'owner') as verified_at,
       (select count(*) from apps a where a.tenant_id = t.id) as apps,
       (select min(d.activated_at) from deployments d where d.tenant_id = t.id and d.activated_at is not null) as first_deploy_at
     from tenants t where t.created_at >= $1 and t.created_at < $2`,
    [from, to],
  );
  const times = rows
    .filter((r) => r.first_deploy_at !== null && r.first_deploy_at !== undefined)
    .map((r) => num(r.first_deploy_at) - num(r.created_at))
    .sort((a, b) => a - b);
  return {
    from,
    to,
    signed_up: rows.length,
    verified: rows.filter((r) => r.verified_at !== null && r.verified_at !== undefined).length,
    created_app: rows.filter((r) => num(r.apps) > 0).length,
    deployed: times.length,
    deployed_within_10_min: times.filter((t) => t <= ACTIVATION_MS).length,
    median_to_first_deploy_ms: times.length === 0 ? null : (times[Math.floor(times.length / 2)] as number),
  };
}

if (import.meta.main) {
  const { openPostgres } = await import("../db/postgres.ts");
  const url = process.env.CONTROL_DATABASE_URL;
  if (url === undefined) {
    process.stderr.write("CONTROL_DATABASE_URL is required\n");
    process.exit(2);
  }
  const at = process.argv.indexOf("--days");
  const days = at === -1 ? 30 : Number(process.argv[at + 1]);
  const db = await openPostgres(url);
  const now = Date.now();
  process.stdout.write(`${JSON.stringify(await funnel(db, now - days * 86_400_000, now), null, 2)}\n`);
  await db.close();
}
