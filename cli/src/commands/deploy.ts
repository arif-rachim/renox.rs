// renox deploy [--json] | renox deploy --rollback [<hash>] [--app <name>] [--json]
//
// Bundle, upload, validate, activate (docs/12-developer-experience.md,
// "Deploy without downtime"; docs/contracts/deploy-api.md sections 3, 4, 6).
// The artifact is the `renox build` esm-dir tree sent as a gzip tar named by
// its content hash; the upload is idempotent by hash, so it is retried on a
// network failure, a 5xx or a 429. Source maps go to the private sourcemap
// endpoint (#128) and never into the artifact. Activation is synchronous: it
// answers once the owning node has migrated, loaded and probed the new cell.
//
// `--rollback` is a pointer switch to the most recently superseded deployment
// (or the one named by a hash or a unique prefix of one). Exit codes follow
// cli/README.md, "Exit codes"; `--json` prints one summary object (for CI and
// bench/scenarios/B15).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeTar } from "@renox/artifact-validate";

import { EnvironmentError, EXIT, UserError } from "../errors.ts";
import { artifactsDir, buildArtifact } from "../lib/build.ts";
import { readProject } from "../lib/project.ts";
import { apiAuth, apiRequest, cliErrorOf, defaultIo, errorBody, type Io } from "./login.ts";

const USAGE = "usage: renox deploy [--json] | renox deploy --rollback [<hash>] [--app <name>] [--json]";
const APP = /^[a-z][a-z0-9-]{0,49}$/u;
/** Attempts of one retried request (upload, sourcemaps, activation), and the first backoff. */
export const ATTEMPTS = 4;
const BACKOFF_MS = 1000;

interface App {
  name: string;
  active_deployment: string | null;
  hostnames: string[];
}

interface Deployment {
  hash: string;
  state: string;
  size_bytes: number;
}

/** Times in ms of each stage, for the summary and B15. */
export interface Stages {
  build_ms: number;
  upload_ms: number;
  sourcemaps_ms: number;
  activate_ms: number;
}

const short = (hash: string): string => hash.slice(0, 12);
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const pad = (line: string, ms: number): string => `${line.padEnd(58)} ${secs(ms)}`;

/** Every regular file under `dir`, by `/`-separated relative path. */
function readTree(dir: string, filter: (path: string) => boolean = () => true): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (rel: string): void => {
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel === "" ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) walk(r);
      else if (d.isFile() && filter(r)) out.set(r, readFileSync(join(dir, r)));
    }
  };
  walk("");
  return out;
}

/**
 * `send` until it answers something other than a retryable status, at most
 * ATTEMPTS times: a network failure, and the statuses in `retryOn`, wait
 * `Retry-After` (at most 30 s) or 1 s, 2 s, 4 s.
 */
export async function withRetry(io: Io, what: string, send: () => Promise<Response>, retryOn: (status: number) => boolean, note: (line: string) => void): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    let failure: unknown;
    try {
      res = await send();
    } catch (e) {
      if (!(e instanceof EnvironmentError)) throw e;
      failure = e;
    }
    if (res !== undefined && !retryOn(res.status)) return res;
    if (attempt >= ATTEMPTS) {
      if (res !== undefined) return res;
      throw failure;
    }
    const after = Number(res?.headers.get("retry-after") ?? "");
    const wait = Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : BACKOFF_MS * 2 ** (attempt - 1);
    note(`  ${what}: ${res === undefined ? (failure as Error).message : `HTTP ${res.status}`}; retrying in ${secs(wait)} (${attempt}/${ATTEMPTS - 1})`);
    await res?.body?.cancel().catch(() => {});
    await io.sleep(wait);
  }
}

const transient = (status: number): boolean => status >= 500 || status === 429;
const unavailable = (status: number): boolean => status === 503 || status === 429;

async function ok<T>(res: Response, ...statuses: number[]): Promise<T> {
  if (!statuses.includes(res.status)) throw cliErrorOf(res.status, await errorBody(res));
  return (await res.json()) as T;
}

/** The app, created on first deploy (deploy-api.md section 3). */
async function ensureApp(io: Io, name: string, out: (l: string) => void): Promise<App> {
  const res = await apiRequest(io, "GET", `/v1/apps/${name}`);
  if (res.status !== 404) return ok<App>(res, 200);
  await res.body?.cancel().catch(() => {});
  const created = await apiRequest(io, "POST", "/v1/apps", { json: { name } });
  const app = await ok<App>(created, 201);
  out(`  Created app ${name}`);
  return app;
}

function liveUrl(app: App): string {
  const host = app.hostnames[0];
  return host === undefined ? "(no hostname yet)" : `https://${host}`;
}

async function deploy(io: Io, project: string, json: boolean): Promise<number> {
  const out = (l: string) => (json ? undefined : io.out(l));
  const t0 = performance.now();
  apiAuth(io.env); // not signed in: fail before building
  const config = readProject(project);
  const name = config.app.name;

  const b0 = performance.now();
  const r = await buildArtifact(project, artifactsDir(project), undefined, { secrets: true });
  for (const k of r.skipped) out(`  skipped ${k.path}: ${k.reason}`);
  for (const a of r.allowedSecrets) out(`  allowed ${a.file}:${a.line}  ${a.pattern}  renox-allow-secret: ${a.allowed}`);
  const tar = writeTar(readTree(r.dir));
  const body = Bun.gzipSync(tar);
  const stages: Stages = { build_ms: performance.now() - b0, upload_ms: 0, sourcemaps_ms: 0, activate_ms: 0 };
  out(pad(`  Bundling… ${r.manifest.routes.length} routes, ${Object.keys(r.manifest.code.entry).length} modules, ${Object.keys(r.templates).length} templates`, stages.build_ms));

  const app = await ensureApp(io, name, out);
  const previous = app.active_deployment;

  const u0 = performance.now();
  const uploaded = await withRetry(
    io,
    "upload",
    () => apiRequest(io, "POST", `/v1/apps/${name}/deployments`, { body, headers: { "content-type": "application/gzip", "x-renox-artifact-hash": r.hash } }),
    transient,
    out,
  );
  const deployment = await ok<Deployment>(uploaded, 200, 201);
  stages.upload_ms = performance.now() - u0;
  const { api } = apiAuth(io.env);
  out(pad(`  Uploading ${mb(body.length)} → ${new URL(api).host}${uploaded.status === 200 ? " (already uploaded)" : ""}`, stages.upload_ms));
  out(`  Validating… ✓ manifest ✓ routes ✓ templates ✓ permissions ✓ bundle (${deployment.state})`);

  // Private source maps for symbolication (#128); a failure does not stop the deploy.
  const s0 = performance.now();
  let sourcemaps: "uploaded" | "none" | "failed" = "none";
  const maps = existsSync(r.mapsDir) ? readTree(r.mapsDir, (p) => p.endsWith(".map")) : new Map<string, Uint8Array>();
  if (maps.size > 0) {
    const res = await withRetry(
      io,
      "sourcemaps",
      () => apiRequest(io, "PUT", `/v1/apps/${name}/deployments/${r.hash}/sourcemaps`, { body: Bun.gzipSync(writeTar(maps)), headers: { "content-type": "application/gzip" } }),
      transient,
      out,
    ).catch(() => undefined);
    sourcemaps = res !== undefined && res.ok ? "uploaded" : "failed";
    await res?.body?.cancel().catch(() => {});
    if (sourcemaps === "failed") out(`  warning: source maps were not uploaded${res === undefined ? "" : ` (HTTP ${res.status})`}; stack traces in the dashboard stay unmapped`);
  }
  stages.sourcemaps_ms = performance.now() - s0;

  const a0 = performance.now();
  const activated = await withRetry(io, "activation", () => apiRequest(io, "POST", `/v1/apps/${name}/activate`, { json: { hash: r.hash } }), unavailable, out);
  await ok<Deployment>(activated, 200);
  stages.activate_ms = performance.now() - a0;
  out(pad(`  Activating… ✓ migrations ✓ cell ✓ probe`, stages.activate_ms));

  const live = await ok<App>(await apiRequest(io, "GET", `/v1/apps/${name}`), 200);
  const total = performance.now() - t0;
  if (json) {
    io.out(JSON.stringify({ app: name, hash: r.hash, previous, url: liveUrl(live), hostnames: live.hostnames, sourcemaps, stages: rounded(stages), total_ms: Math.round(total) }));
    return EXIT.OK;
  }
  out(pad(`  Live: ${liveUrl(live)}  (${short(r.hash)})`, total).replace(/ (\S+)$/u, " total $1"));
  if (previous !== null && previous !== r.hash) out(`  Rollback: renox deploy --rollback ${short(previous)}`);
  return EXIT.OK;
}

const rounded = (s: Stages): Stages => ({
  build_ms: Math.round(s.build_ms),
  upload_ms: Math.round(s.upload_ms),
  sourcemaps_ms: Math.round(s.sourcemaps_ms),
  activate_ms: Math.round(s.activate_ms),
});

/** A full hash, or the one superseded deployment whose hash starts with `prefix`. */
async function resolveHash(io: Io, app: string, prefix: string): Promise<string> {
  if (/^[0-9a-f]{64}$/u.test(prefix)) return prefix;
  if (!/^[0-9a-f]{6,63}$/u.test(prefix)) throw new UserError(`${JSON.stringify(prefix)} is not a deployment hash`, { hint: "give the hash `renox deploy` printed (at least 6 hex characters)" });
  const res = await apiRequest(io, "GET", `/v1/apps/${app}/deployments?state=superseded&limit=100`);
  const { deployments } = await ok<{ deployments: Deployment[] }>(res, 200);
  const hits = deployments.filter((d) => d.hash.startsWith(prefix));
  if (hits.length === 1) return (hits[0] as Deployment).hash;
  throw new UserError(hits.length === 0 ? `no superseded deployment of ${app} starts with ${prefix}` : `${prefix} matches ${hits.length} deployments of ${app}`, {
    hint: "give more characters of the hash, or run `renox deploy --rollback` for the previous deployment",
  });
}

async function rollback(io: Io, app: string, target: string | undefined, json: boolean): Promise<number> {
  const t0 = performance.now();
  apiAuth(io.env);
  const hash = target === undefined ? undefined : await resolveHash(io, app, target);
  const before = await ok<App>(await apiRequest(io, "GET", `/v1/apps/${app}`), 200);
  const res = await withRetry(io, "rollback", () => apiRequest(io, "POST", `/v1/apps/${app}/rollback`, { json: hash === undefined ? {} : { hash } }), unavailable, (l) => (json ? undefined : io.out(l)));
  const d = await ok<Deployment>(res, 200);
  const live = await ok<App>(await apiRequest(io, "GET", `/v1/apps/${app}`), 200);
  const total = performance.now() - t0;
  if (json) {
    io.out(JSON.stringify({ app, hash: d.hash, previous: before.active_deployment, url: liveUrl(live), hostnames: live.hostnames, total_ms: Math.round(total) }));
    return EXIT.OK;
  }
  io.out(pad(`  Rolled back: ${liveUrl(live)}  (${short(d.hash)})`, total).replace(/ (\S+)$/u, " total $1"));
  if (before.active_deployment !== null && before.active_deployment !== d.hash) io.out(`  Undo: renox deploy --rollback ${short(before.active_deployment)}`);
  return EXIT.OK;
}

export async function run(args: string[], io: Io = defaultIo(), project: string = process.cwd()): Promise<number> {
  let json = false;
  let isRollback = false;
  let target: string | undefined;
  let app: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--json") json = true;
    else if (a === "--rollback") {
      isRollback = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) target = args[++i];
    } else if (a === "--app") {
      app = args[++i];
      if (app === undefined || !APP.test(app)) throw new UserError(`--app ${JSON.stringify(app ?? "")} is not an app name`, { hint: USAGE });
    } else throw new UserError(`unknown argument ${JSON.stringify(a)}`, { hint: USAGE });
  }
  if (!isRollback) {
    if (app !== undefined) throw new UserError("--app goes with --rollback; a deploy uses the app of renox.toml", { hint: USAGE });
    return deploy(io, project, json);
  }
  return rollback(io, app ?? readProject(project).app.name, target, json);
}
