// B15 (docs/14-benchmarks.md): `renox deploy` of the example app to a local
// control plane ≤ 30 s end to end, rollback ≤ 5 s; fail > 60 s.
// Usage: bun bench/scenarios/B15/deploy.ts <runs> <out.json>
//
// One stack for all runs: control/api (RENOX_TEST_PG, or PGlite in memory)
// and one controlled renox-worker (RENOX_WORKER_PATH). Each run deploys a
// fresh copy of examples/shop with a new version route (so every run is a new
// hash, a cold build, a new upload and a new cell), as a `renox` process:
//
//   deploy_ms   process start -> the worker answers the new version with 200
//               (bundle, upload, validate, source maps, activate, route delta,
//               new isolate, first request)
//   stages      build_ms, upload_ms, sourcemaps_ms, activate_ms from
//               `renox deploy --json`; cli_ms = process start -> exit;
//               route_ms = exit -> first 200 of the new version
//   rollback_ms `renox deploy --rollback` start -> the worker answers the
//               previous version with 200
//
// Run 1 creates the app; its first deploy has no previous deployment to roll
// back to, so rollback samples start at run 2 (run 1 rolls back to nothing:
// it deploys twice).

import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { summarize } from "../../lib/stats.ts";

const [runsArg = "5", out] = process.argv.slice(2);
const worker = process.env.RENOX_WORKER_PATH;
if (!out || !worker) {
  console.error("usage: RENOX_WORKER_PATH=<renox-worker> bun bench/scenarios/B15/deploy.ts <runs> <out.json>");
  process.exit(2);
}
const repo = join(import.meta.dir, "../../..");
const cliMain = join(repo, "cli/src/main.ts");
const HOST = "shop.renox.test";

const b32 = (n: number): string => [...randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: HOST } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
      });
      res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** Polls every 5 ms until `f` is true; the time it became true, from performance.now(). */
async function until(what: string, ms: number, f: () => Promise<boolean>): Promise<number> {
  const deadline = performance.now() + ms;
  for (;;) {
    if (await f().catch(() => false)) return performance.now();
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const procs: { kill: () => void }[] = [];
process.on("exit", () => {
  for (const p of procs) p.kill();
});

const root = mkdtempSync(join(tmpdir(), "renox-b15-"));
const apiPort = await freePort();
const api = `http://127.0.0.1:${apiPort}`;
// The node-facing listener (#218): the worker's [control] url.
const nodePort = await freePort();
const operator = `renox_op_${b32(32)}`;
procs.push(
  Bun.spawn(["bun", join(repo, "control/api/src/main.ts")], {
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: process.env.RENOX_TEST_PG ?? "pglite:memory",
      CONTROL_LISTEN_PORT: String(apiPort),
      CONTROL_NODE_LISTEN_HOST: "127.0.0.1",
      CONTROL_NODE_LISTEN_PORT: String(nodePort),
      CONTROL_OPERATOR_TOKEN_SHA256: sha256(operator),
      CONTROL_MASTER_KEY: randomBytes(32).toString("base64"),
      CONTROL_PLATFORM_DOMAIN: "renox.test",
    },
    stdout: "ignore",
    stderr: Bun.file(join(root, "api.log")),
  }),
);
await until("the control API", 60_000, async () => (await fetch(`${api}/v1/healthz`)).ok);
const op = (path: string, body: unknown) => fetch(`${api}${path}`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const tenant = (await (await op("/v1/admin/tenants", { tenant_id: "t-b15", name: "b15", tier: "paid" })).json()) as { token: string | { token: string } };
const token = typeof tenant.token === "string" ? tenant.token : tenant.token.token;
const nodeToken = ((await (await op("/v1/admin/nodes", { node_id: "node-b15" })).json()) as { token: string }).token;
writeFileSync(join(root, "node.token"), nodeToken, { mode: 0o600 });

const port = await freePort();
const health = await freePort();
writeFileSync(
  join(root, "worker.toml"),
  `mode = "controlled"
listen = "127.0.0.1:${port}"
node_id = "node-b15"
data_dir = "${root}/w/data"
artifacts_dir = "${root}/w/artifacts"
meters_dir = "${root}/w/meters"
logs_dir = "${root}/w/logs"
fetch_blocked_addresses = ["203.0.113.250"]
[gateway]
rate_limit_per_ip = 100000.0
rate_limit_burst = 100000
max_connections_per_ip = 1000
[control]
url = "http://127.0.0.1:${nodePort}"
node_token_file = "${root}/node.token"
health_listen = "127.0.0.1:${health}"
[sandbox]
allow_unsandboxed = true
`,
);
procs.push(Bun.spawn([worker, "--config", join(root, "worker.toml")], { stdout: "ignore", stderr: Bun.file(join(root, "worker.log")) }));
await until("the worker", 60_000, async () => (await fetch(`http://127.0.0.1:${health}/healthz`)).ok);

const env = { ...process.env, RENOX_TOKEN: token, RENOX_API_URL: api, XDG_CONFIG_HOME: root };

/** A fresh copy of examples/shop whose /api/b15-version answers `version`. */
function shop(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-b15-shop-"));
  cpSync(join(repo, "examples/shop"), dir, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".renox") && !p.includes("screenshots") });
  cpSync(join(repo, "examples/shop/node_modules"), join(dir, "node_modules"), { recursive: true, dereference: true });
  writeFileSync(join(dir, "functions/api/b15-version.ts"), `export const GET = () => new Response(${JSON.stringify(version)});\n`);
  return dir;
}

const serves = (version: string) => async () => {
  const r = await get(port, "/api/b15-version");
  return r.status === 200 && r.body === version;
};

interface Summary {
  hash: string;
  stages: { build_ms: number; upload_ms: number; sourcemaps_ms: number; activate_ms: number };
}

async function deploy(version: string): Promise<{ deploy_ms: number; cli_ms: number; route_ms: number; s: Summary }> {
  const dir = shop(version);
  const t0 = performance.now();
  const p = Bun.spawn(["bun", cliMain, "deploy", "--json"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const exited = performance.now();
  if (code !== 0) throw new Error(`renox deploy exited ${code}: ${stderr}`);
  const live = await until(`version ${version}`, 30_000, serves(version));
  return { deploy_ms: live - t0, cli_ms: exited - t0, route_ms: live - exited, s: JSON.parse(stdout) as Summary };
}

async function rollback(expect: string): Promise<number> {
  const t0 = performance.now();
  const p = Bun.spawnSync(["bun", cliMain, "deploy", "--rollback", "--app", "shop", "--json"], { cwd: root, env });
  if (p.exitCode !== 0) throw new Error(`renox deploy --rollback exited ${p.exitCode}: ${p.stderr.toString()}`);
  return (await until(`rollback to ${expect}`, 30_000, serves(expect))) - t0;
}

const samples: Record<string, number[]> = { deploy_ms: [], cli_ms: [], route_ms: [], build_ms: [], upload_ms: [], sourcemaps_ms: [], activate_ms: [], rollback_ms: [] };
const runs = Number(runsArg);
let previous: string | null = null;
for (let run = 1; run <= runs; run++) {
  // Run 1 deploys a base version first, so every run has something to roll back to.
  if (previous === null) {
    await deploy("base");
    previous = "base";
  }
  const version = `v${run}`;
  const d = await deploy(version);
  for (const k of ["deploy_ms", "cli_ms", "route_ms"] as const) samples[k]?.push(d[k]);
  for (const [k, v] of Object.entries(d.s.stages)) samples[k]?.push(v);
  const r = await rollback(previous);
  samples.rollback_ms?.push(r);
  // Forward again, so the next run's previous version is this one.
  const again = Bun.spawnSync(["bun", cliMain, "deploy", "--rollback", "--app", "shop", "--json"], { cwd: root, env });
  if (again.exitCode !== 0) throw new Error(`roll forward failed: ${again.stderr.toString()}`);
  await until(`roll forward to ${version}`, 30_000, serves(version));
  previous = version;
  console.error(`run ${run}: deploy ${d.deploy_ms.toFixed(0)} ms (${JSON.stringify(d.s.stages)}, route ${d.route_ms.toFixed(0)} ms), rollback ${r.toFixed(0)} ms`);
}

const median = (xs: number[]) => summarize(xs).p50;
const result = {
  id: "B15",
  scenario: "renox deploy of examples/shop (fresh copy, new hash each run) to a local control plane (control/api on PGlite, in-memory artifact store) and one controlled renox-worker; time to the first 200 of the new version; rollback to the first 200 of the previous one",
  notes: `${worker.includes("/debug/") ? "debug" : "release"} renox-worker; the CLI, the API and the worker share the machine`,
  samples,
  summary: {
    deploy_s: Math.round(summarize(samples.deploy_ms as number[]).p50) / 1000,
    rollback_s: Math.round(summarize(samples.rollback_ms as number[]).p50) / 1000,
    deploy_p99_s: Math.round(summarize(samples.deploy_ms as number[]).p99) / 1000,
    rollback_p99_s: Math.round(summarize(samples.rollback_ms as number[]).p99) / 1000,
    ...Object.fromEntries(["build_ms", "upload_ms", "sourcemaps_ms", "activate_ms", "cli_ms", "route_ms"].map((k) => [`${k}_p50`, Math.round(median(samples[k] as number[]))])),
  },
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
process.exit(0);
