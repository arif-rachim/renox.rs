// Entry point: `bun control/api/src/main.ts`. Reads the configuration from the
// environment (config.ts), migrates the database, and serves the API on two
// listeners (ADR D23, #218): the public one (`CONTROL_LISTEN_PORT`) never
// routes `/v1/nodes/*` or `/v1/ingest/*`; the node one
// (`CONTROL_NODE_LISTEN_HOST`:`CONTROL_NODE_LISTEN_PORT`) serves only those
// and `/v1/healthz`. Only nodes may reach the node listener's address, and
// every node lists it in `fetch_blocked_addresses`.

import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { migrate } from "./db/migrate.ts";
import { openPostgres } from "./db/postgres.ts";
import { openPglite } from "./db/pglite.ts";
import { MemoryObjectStore, S3ObjectStore } from "./storage/object-store.ts";
import type { Db } from "./db/db.ts";
import { sweepErasures } from "./tenants/erasure.ts";
import { endExpiredImpersonations } from "./ops/breakglass.ts";
import { routeService } from "./routes/service.ts";
import { sweep } from "./workers/health.ts";
import { NullMailer, OutboxDirMailer } from "./auth/mailer.ts";
import { startDomainJobs } from "./domains/jobs.ts";
import { sweepBilling } from "./billing/sweep.ts";

const log = createLogger();
const config = loadConfig();

/** The node listener: a port of its own, and the address it binds (default: every interface). */
function nodeListener(env: Record<string, string | undefined>): { hostname: string; port: number } {
  const port = Number(env.CONTROL_NODE_LISTEN_PORT ?? "8788");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("CONTROL_NODE_LISTEN_PORT is not a port");
  if (port === config.port) throw new ConfigError("CONTROL_NODE_LISTEN_PORT must differ from CONTROL_LISTEN_PORT");
  return { hostname: env.CONTROL_NODE_LISTEN_HOST ?? "0.0.0.0", port };
}
const nodeAt = nodeListener(process.env);

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
const publicApp = createApp(deps, [], "public");
const nodeApp = createApp(deps, [], "node");
// Route changes made by other API instances reach this instance's nodes.
await routeService(deps).publisher.listen();
// Node health and drained routes (deploy-api.md sections 7-8).
setInterval(() => void sweep(deps).catch((e: unknown) => log.error("sweep failed", { error: String(e) })), 5_000);
// Custom domains: verification, DNS checks, certificates (src/domains/README.md).
await startDomainJobs(deps);
// Tenant erasures (#308): due steps retried every minute (each erasure's own retry is hourly).
// Break-glass impersonations past their 60 minutes end with an audit row and the owner's email (#310).
setInterval(() => void endExpiredImpersonations(deps).catch((e: unknown) => log.error("impersonation sweep failed", { error: String(e) })), 30_000);
setInterval(() => void sweepErasures(deps).catch((e: unknown) => log.error("erasure sweep failed", { error: String(e) })), Math.min(60_000, config.erasureRetryMs ?? 60_000));
// Platform billing (#325): the tier signal, the owner's emails, the anomaly reviews and the monthly close, hourly.
setInterval(() => void sweepBilling(deps).catch((e: unknown) => log.error("billing sweep failed", { error: String(e) })), 3_600_000);
if ((config.exportKmsKeyId ?? null) === null) log.warn("EXPORT_KMS_KEY_ID is not set: exports are written without SSE-KMS (local mode only)");

const server = Bun.serve({ port: config.port, fetch: publicApp.fetch, idleTimeout: 0 });
const nodeServer = Bun.serve({ hostname: nodeAt.hostname, port: nodeAt.port, fetch: nodeApp.fetch, idleTimeout: 0 });
log.info("control api listening", { port: server.port, node_host: nodeAt.hostname, node_port: nodeServer.port, migrations_applied: applied });
