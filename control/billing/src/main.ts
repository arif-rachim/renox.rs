// The billing job runner: `bun control/billing/src/main.ts`. Runs the rollup
// and the quota signal once at start and then every hour, against the control
// plane's Postgres (CONTROL_DATABASE_URL, the same database as control/api,
// whose migrations own the meters_raw and meters_hourly tables).
//
//   --once                 run one pass and exit
//   --from <ms> --to <ms>  backfill: recompute these hours (implies --once)

import { SQL } from "bun";
import type { Queryable } from "./db.ts";
import { runOnce, type JobLog } from "./job.ts";
import { HOUR_MS } from "./db.ts";

const url = process.env.CONTROL_DATABASE_URL;
if (url === undefined || !url.startsWith("postgres")) {
  process.stderr.write("CONTROL_DATABASE_URL must be a postgres:// URL\n");
  process.exit(2);
}
const sql = new SQL(url);
const db: Queryable = { query: async (text, params = []) => [...(await sql.unsafe(text, [...params]))] };
const write = (level: string, msg: string, fields: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ ts: Date.now(), level, msg, ...fields })}\n`);
};
const log: JobLog = { info: (m, f) => write("info", m, f), warn: (m, f) => write("warn", m, f) };

const arg = (name: string): number | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : Number(process.argv[at + 1]);
};
const from = arg("--from");
const to = arg("--to");

if (from !== undefined || to !== undefined) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    process.stderr.write("--from and --to take Unix milliseconds\n");
    process.exit(2);
  }
  await runOnce(db, Date.now(), log, { from: from as number, to: to as number });
  await sql.close();
} else if (process.argv.includes("--once")) {
  await runOnce(db, Date.now(), log);
  await sql.close();
} else {
  const tick = (): void => void runOnce(db, Date.now(), log).catch((e: unknown) => write("error", "billing run failed", { error: String(e) }));
  tick();
  setInterval(tick, HOUR_MS);
}
