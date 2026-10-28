// Entry point: `bun control/api/src/main.ts`. Reads the configuration from the
// environment (config.ts), migrates the database, and serves the API.

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { migrate } from "./db/migrate.ts";
import { openPostgres } from "./db/postgres.ts";
import { openPglite } from "./db/pglite.ts";
import { MemoryObjectStore, S3ObjectStore } from "./storage/object-store.ts";
import type { Db } from "./db/db.ts";
import { routeService } from "./routes/service.ts";
import { sweep } from "./workers/health.ts";
import { NullMailer, OutboxDirMailer } from "./auth/mailer.ts";

const log = createLogger();
const config = loadConfig();

async function openDb(url: string): Promise<Db> {
  if (url === "pglite:memory") return openPglite();
  if (url.startsWith("pglite:")) return openPglite(url.slice("pglite:".length));
  return openPostgres(url);
}

const db = await openDb(config.databaseUrl);
const applied = await migrate(db);
if (config.s3 === null) log.warn("CONTROL_S3_ENDPOINT is not set: artifacts are kept in memory only");
const store = config.s3 === null ? new MemoryObjectStore() : new S3ObjectStore(config.s3);
if (config.mailOutboxDir === null) log.warn("CONTROL_MAIL_OUTBOX_DIR is not set: account emails are dropped");
const mailer = config.mailOutboxDir === null ? new NullMailer(log) : new OutboxDirMailer(config.mailOutboxDir);
const deps = { db, store, config, log, mailer, now: Date.now };
const app = createApp(deps);
// Route changes made by other API instances reach this instance's nodes.
await routeService(deps).publisher.listen();
// Node health and drained routes (deploy-api.md sections 7-8).
setInterval(() => void sweep(deps).catch((e: unknown) => log.error("sweep failed", { error: String(e) })), 5_000);

const server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 0 });
log.info("control api listening", { port: server.port, migrations_applied: applied });
