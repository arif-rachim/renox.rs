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
import { MemoryObjectStore, S3ObjectStore } from "./storage/object-store.ts";
import type { Db } from "./db/db.ts";
import { sweepErasures } from "./tenants/erasure.ts";
import { endExpiredImpersonations } from "./ops/breakglass.ts";
import { routeService } from "./routes/service.ts";
import { sweep } from "./workers/health.ts";
import { mailerFor } from "./auth/mailer.ts";
import { behindProxies, TrustedProxies, type AddressSource } from "./auth/ip.ts";
import { startDomainJobs } from "./domains/jobs.ts";
import { sweepBilling } from "./billing/sweep.ts";
import { sweepAbuse } from "./abuse/takedown.ts";
import { sweepSafeBrowsing } from "./safe-browsing/check.ts";
import { rescanActive } from "./deployments/advisories.ts";

const log = createLogger();
/** A configuration error exits with 78 (EX_CONFIG): renox-control.service does not restart on it (#366). */
function loadOrExit(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log.error("configuration refused", { error: e.message });
    process.exit(78);
  }
}
const config = loadOrExit();

/** The node listener: a port of its own, and the address it binds (default: every interface). */
function nodeListener(env: Record<string, string | undefined>): { hostname: string; port: number } {
  const port = Number(env.CONTROL_NODE_LISTEN_PORT ?? "8788");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("CONTROL_NODE_LISTEN_PORT is not a port");
  if (port === config.port) throw new ConfigError("CONTROL_NODE_LISTEN_PORT must differ from CONTROL_LISTEN_PORT");
  return { hostname: env.CONTROL_NODE_LISTEN_HOST ?? "0.0.0.0", port };
}
const nodeAt = nodeListener(process.env);

/**
 * PGlite is a development and test database (a devDependency): it is loaded
 * only for a `pglite:` URL, so a `bun install --production` tree, which has
 * no PGlite, starts the API on Postgres (#400).
 */
async function openDb(url: string): Promise<Db> {
  if (!url.startsWith("pglite:")) return openPostgres(url);
  const { openPglite } = await import("./db/pglite.ts");
  return url === "pglite:memory" ? openPglite() : openPglite(url.slice("pglite:".length));
}

const db = await openDb(config.databaseUrl);
const applied = await migrate(db);
if (config.s3 === null) log.warn("CONTROL_S3_ENDPOINT is not set: artifacts are kept in memory only");
const store = config.s3 === null ? new MemoryObjectStore() : new S3ObjectStore(config.s3);
// The mailer (#385): Resend in production, the file outbox in development, otherwise none.
const mailer = mailerFor(config.mail ?? (config.mailOutboxDir === null ? { provider: "none", from: "" } : { provider: "outbox", from: "", dir: config.mailOutboxDir }), log);
const deps = { db, store, config, log, mailer, now: Date.now };
const publicApp = createApp(deps, [], "public");
const nodeApp = createApp(deps, [], "node");
// Route changes made by other API instances reach this instance's nodes.
await routeService(deps).publisher.listen();
// Node health and drained routes (deploy-api.md sections 7-8).
setInterval(() => void sweep(deps).catch((e: unknown) => log.error("sweep failed", { error: String(e) })), 5_000);
// Custom domains through Cloudflare for SaaS: the status poll (src/domains/README.md).
startDomainJobs(deps);
// Tenant erasures (#308): due steps retried every minute (each erasure's own retry is hourly).
// Break-glass impersonations past their 60 minutes end with an audit row and the owner's email (#310).
setInterval(() => void endExpiredImpersonations(deps).catch((e: unknown) => log.error("impersonation sweep failed", { error: String(e) })), 30_000);
setInterval(() => void sweepErasures(deps).catch((e: unknown) => log.error("erasure sweep failed", { error: String(e) })), Math.min(60_000, config.erasureRetryMs ?? 60_000));
// Platform billing (#325): the tier signal, the owner's emails, the anomaly reviews and the monthly close, hourly.
setInterval(() => void sweepBilling(deps).catch((e: unknown) => log.error("billing sweep failed", { error: String(e) })), 3_600_000);
// Abuse (#123): the takedown SLA alert and the reporters' 90 days, every minute;
// Safe Browsing (hostnames unchecked for a day) and the OSV re-scan of active deployments, hourly.
setInterval(() => void sweepAbuse(deps).catch((e: unknown) => log.error("abuse sweep failed", { error: String(e) })), 60_000);
setInterval(() => void sweepSafeBrowsing(deps).catch((e: unknown) => log.error("safe browsing sweep failed", { error: String(e) })), 3_600_000);
setInterval(() => void rescanActive(deps).catch((e: unknown) => log.error("advisory re-scan failed", { error: String(e) })), 3_600_000);
if (!process.env.RENOX_SAFE_BROWSING_KEY) log.warn("RENOX_SAFE_BROWSING_KEY is not set: hostnames are not checked with Safe Browsing");
if ((config.exportKmsKeyId ?? null) === null) log.info("EXPORT_KMS_KEY_ID is not set: exports are written without SSE-KMS (R2 has none; the bucket's own encryption at rest applies)");

// The public listener behind a trusted proxy (#366): requests from a listed peer
// take their client address from the configured header (src/auth/ip.ts).
const proxies = new TrustedProxies(config.trustedProxies ?? []);
const clientIpHeader = config.clientIpHeader ?? "CF-Connecting-IP";
if (proxies.size > 0) log.info("trusted proxies", { proxies: proxies.entries.join(","), header: clientIpHeader });
const server = Bun.serve({
  hostname: config.listenHost ?? "0.0.0.0",
  port: config.port,
  fetch: (req, srv) => publicApp.fetch(req, behindProxies(srv as AddressSource, proxies, clientIpHeader)),
  idleTimeout: 0,
});
const nodeServer = Bun.serve({ hostname: nodeAt.hostname, port: nodeAt.port, fetch: nodeApp.fetch, idleTimeout: 0 });
log.info("control api listening", { host: config.listenHost ?? "0.0.0.0", port: server.port, node_host: nodeAt.hostname, node_port: nodeServer.port, migrations_applied: applied });
