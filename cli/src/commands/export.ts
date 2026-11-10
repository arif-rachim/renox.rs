// renox export [--out <dir>] [--app <name>] [--json]
//
// A self-contained, runnable copy of a deployed app (#673; docs/contracts/deploy-api.md
// 0.8 section 14): the database, the files and the active artifact, each
// downloaded through its signed URL without the API token and checked against
// the SHA-256 the API reported, laid out the way `renox-worker --config worker.toml`
// reads a directory (the layout `renox dev` writes under .renox/):
//
//   manifest.json           what was exported, with the hashes
//   worker.toml             the worker's config (local mode)
//   routes.json             every hostname of the app, 127.0.0.1 and localhost -> the artifact
//   platform.key            32 random bytes as hex, 0600 (platform sessions are not carried over)
//   secrets.txt             the secret NAMES (values never leave the platform)
//   artifact/<hash>/        the active deployment
//   data/<tenant_id>/app.db the database
//   data/<tenant_id>/secrets.json   {} 0600: fill it in before starting
//   data/files/tenants/<tenant_id>/files/<key>   the stored files
//
// A failure after the first byte is written removes everything this command
// wrote: a directory it created is removed, a directory that existed (empty)
// is emptied again and kept.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { EnvironmentError, EXIT, UserError } from "../errors.ts";
import { downloadVerified } from "../lib/download.ts";
import { readProject } from "../lib/project.ts";
import { routeEntries, writeRoutesFile } from "../lib/routes-file.ts";
import { untarGz } from "../lib/untar.ts";
import { PINNED_WORKER } from "../worker/verify.ts";
import type { App } from "./apps.ts";
import { apiAuth, apiRequest, cliErrorOf, defaultIo, errorBody, type Io } from "./login.ts";

const USAGE = "usage: renox export [--out <dir>] [--app <name>] [--json]";
const APP = /^[a-z][a-z0-9-]{0,49}$/u;
const TENANT = /^[A-Za-z0-9_-]+$/u;
const HASH = /^[0-9a-f]{64}$/u;

interface Exported {
  url: string;
  expires_at: number;
  created_at: number;
  size_bytes: number;
  sha256: string;
  kind?: string;
  files?: number;
  hash?: string;
}

async function ok<T>(res: Response, status: number): Promise<T> {
  if (res.status !== status) throw cliErrorOf(res.status, await errorBody(res));
  return (await res.json()) as T;
}

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");

function emptyDir(dir: string): void {
  for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
}

function workerToml(): string {
  return [
    "# Runs the exported app: renox-worker --config worker.toml",
    "# The paths are relative to this file. Before the first start put the app's secret",
    "# values in data/<tenant_id>/secrets.json (the names are in secrets.txt).",
    "# The guide: docs/self-host.md.",
    `listen = "127.0.0.1:8080"`,
    `data_dir = "data"`,
    `artifacts_dir = "artifact"`,
    `routes_file = "routes.json"`,
    `meters_dir = "meters"`,
    `logs_dir = "logs"`,
    `platform_key_file = "platform.key"`,
    `idle_timeout_secs = 600`,
    // The route table file has no tier field (the gateway refuses unknown fields); the tier is the worker's default.
    `default_tier = "paid"`,
    "",
    "[jobs]",
    "enabled = true",
    "",
  ].join("\n");
}

export async function run(args: string[], io: Io = defaultIo(), cwd = process.cwd()): Promise<number> {
  let outFlag: string | undefined;
  let appFlag: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--out" || a === "--app") {
      const v = args[++i];
      if (v === undefined || v === "") throw new UserError(`${a} needs a value`, { hint: USAGE });
      if (a === "--out") outFlag = v;
      else appFlag = v;
    } else if (a === "--json") json = true;
    else throw new UserError(a.startsWith("--") ? `unknown argument ${JSON.stringify(a)}` : `unexpected argument ${JSON.stringify(a)}`, { hint: USAGE });
  }
  if (appFlag !== undefined && !APP.test(appFlag)) throw new UserError(`--app ${JSON.stringify(appFlag)} is not an app name`, { hint: USAGE });
  apiAuth(io.env);
  const name = appFlag ?? readProject(cwd).app.name;
  const outName = outFlag ?? `${name}-export-${stamp(Date.now())}`;
  const out = isAbsolute(outName) ? outName : resolve(cwd, outName);
  // Refused before any request.
  const existed = existsSync(out);
  if (existed) {
    if (!statSync(out).isDirectory() || readdirSync(out).length > 0) throw new UserError(`${outName} exists and is not an empty directory`, { hint: "choose another --out; nothing was exported" });
  }
  const say = (line: string): void => {
    if (!json) io.out(line);
  };

  mkdirSync(out, { recursive: true });
  try {
    return await exportInto(io, name, out, outName, say, json);
  } catch (e) {
    try {
      if (existed) emptyDir(out);
      else rmSync(out, { recursive: true, force: true });
    } catch {
      // Best effort: the original error is the one to report.
    }
    throw e;
  }
}

async function exportInto(io: Io, name: string, out: string, outName: string, say: (l: string) => void, json: boolean): Promise<number> {
  const base = `/v1/apps/${name}`;
  const app = await ok<App & { database?: string }>(await apiRequest(io, "GET", base), 200);
  const hash = app.active_deployment;
  if (hash === null || hash === undefined) throw new UserError(`${name} has no live deployment to export`, { hint: "run `renox deploy` first" });
  if (!HASH.test(hash)) throw new EnvironmentError("the API answered an artifact hash that is not 64 hex digits");
  const tenant = app.tenant_id;
  if (!TENANT.test(tenant)) throw new EnvironmentError("the API answered a tenant id this command cannot lay out");
  say(`Exporting ${name} (tenant ${tenant}, deployment ${hash.slice(0, 12)}) to ${outName}`);

  // The database.
  const dbDir = join(out, "data", tenant);
  mkdirSync(dbDir, { recursive: true });
  const db = await ok<Exported>(await apiRequest(io, "POST", `${base}/backups/export`, { json: {} }), 201);
  await downloadVerified(io, db.url, db.sha256, join(dbDir, "app.db"));
  say(`Database: data/${tenant}/app.db (${statSync(join(dbDir, "app.db")).size} bytes, sha256 ${db.sha256})`);

  // The files.
  const files = await ok<Exported>(await apiRequest(io, "POST", `${base}/files/export`, { json: {} }), 201);
  const filesTar = join(out, "files.tar.gz");
  await downloadVerified(io, files.url, files.sha256, filesTar);
  const count = await untarGz(filesTar, join(out, "data", "files"), { allowPrefix: `tenants/${tenant}/files/` });
  rmSync(filesTar, { force: true });
  if (files.files !== undefined && files.files !== count) throw new EnvironmentError(`the files archive held ${count} files, the export announced ${files.files}`, { hint: "nothing was kept; run `renox export` again" });
  say(`Files: ${count} file${count === 1 ? "" : "s"} under data/files/tenants/${tenant}/files/ (sha256 ${files.sha256})`);

  // The artifact.
  const art = await ok<Exported>(await apiRequest(io, "POST", `${base}/deployments/${hash}/export`, { json: {} }), 201);
  const artTar = join(out, "artifact.tar.gz");
  await downloadVerified(io, art.url, art.sha256, artTar);
  const artDir = join(out, "artifact", hash);
  await untarGz(artTar, artDir, { allowPrefix: "", dirs: "skip" });
  rmSync(artTar, { force: true });
  say(`Artifact: artifact/${hash}/ (sha256 ${art.sha256})`);
  let modules: { name: string; version: string }[] = [];
  try {
    const m = JSON.parse(readFileSync(join(artDir, "manifest.json"), "utf8")) as { modules?: { name: string; version: string }[] };
    modules = (m.modules ?? []).map((x) => ({ name: x.name, version: x.version }));
  } catch {
    throw new EnvironmentError("the exported artifact has no readable manifest.json", { hint: "nothing was kept; run `renox export` again" });
  }

  // The secret names.
  const sec = await ok<{ secrets: { name: string }[] }>(await apiRequest(io, "GET", `${base}/secrets`), 200);
  writeFileSync(join(out, "secrets.txt"), [`# values are not exported; set them in data/${tenant}/secrets.json before starting`, ...sec.secrets.map((s) => s.name), ""].join("\n"));
  say(`Secrets: ${sec.secrets.length} name${sec.secrets.length === 1 ? "" : "s"} in secrets.txt (values are not exported)`);

  // The worker's directory.
  const hostnames = [...new Set([...app.hostnames, "127.0.0.1", "localhost"])];
  writeRoutesFile(join(out, "routes.json"), routeEntries({ hostnames, tenantId: tenant, hash }));
  writeFileSync(join(out, "worker.toml"), workerToml());
  writeFileSync(join(out, "platform.key"), Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), { mode: 0o600 });
  chmodSync(join(out, "platform.key"), 0o600);
  writeFileSync(join(dbDir, "secrets.json"), "{}", { mode: 0o600 });
  chmodSync(join(dbDir, "secrets.json"), 0o600);
  const dbSize = statSync(join(dbDir, "app.db")).size;
  const manifest = {
    renox_export: 1,
    app: name,
    tenant_id: tenant,
    hostnames: app.hostnames,
    hash,
    exported_at: new Date().toISOString(),
    worker_version: PINNED_WORKER.version,
    modules,
    files: { count, sha256: files.sha256 },
    database: { size_bytes: dbSize, sha256: db.sha256 },
    artifact: { sha256: art.sha256 },
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (json) io.out(JSON.stringify({ out: outName, hash, database: { sha256: db.sha256 }, files: { sha256: files.sha256 }, artifact: { sha256: art.sha256 } }));
  else {
    io.out(`Exported ${name} to ${outName}.`);
    io.out(`Next: put the secret values in ${outName}/data/${tenant}/secrets.json, then run: cd ${outName} && renox-worker --config worker.toml`);
  }
  return EXIT.OK;
}
