// The re-seal job of a master key rotation, on demand (#451;
// ops/security/keys.md, "Master key"). The control API also runs it hourly
// and at start (src/main.ts); this is for the operator who wants it done now:
//
//   bun control/api/scripts/reseal.ts
//
// with the control API's environment (`CONTROL_DATABASE_URL`,
// `CONTROL_MASTER_KEY` and `CONTROL_MASTER_KEY_PREVIOUS`), for example
// through `systemd-run --property=EnvironmentFile=/etc/renox/control.env`,
// so no key is ever on a command line. Prints one JSON line of counts (never
// a value, a key or a ciphertext) and exits 0 when nothing is left under the
// previous key, 1 when something is (run it again, or look at the rows named
// as unreadable), 78 when the configuration is refused.

import { ConfigError, loadConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { openPostgres } from "../src/db/postgres.ts";
import { masterKeys } from "../src/secrets/master.ts";
import { reseal, summary } from "../src/secrets/reseal.ts";

const log = createLogger((line) => process.stderr.write(`${line}\n`));
let config;
try {
  config = loadConfig();
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  log.error("configuration refused", { error: e.message });
  process.exit(78);
}
if (config.databaseUrl.startsWith("pglite:")) {
  log.error("CONTROL_DATABASE_URL must be the control API's Postgres; an in-memory or file PGlite holds nothing to re-seal");
  process.exit(78);
}
const db = await openPostgres(config.databaseUrl);
// The columns of migration 0032 exist once the control API of #451 has started.
const [m] = await db.query<{ v: unknown }>("select coalesce(max(version), 0) as v from schema_migrations");
if (Number(m?.v ?? 0) < 32) {
  log.error("the control database is older than migration 0032: start the control API of this release first");
  process.exit(78);
}
const report = await reseal({ db, config, log });
const { line, exitCode } = summary(masterKeys({ config }), report);
process.stdout.write(`${line}\n`);
process.exit(exitCode);
