// B18 (docs/14-benchmarks.md, #257): kill a node; the base-tier tenant
// recovers from Litestream. RTO ≤ 60 s, RPO ≤ 10 s; fail RPO > 60 s.
// Usage: bun bench/scenarios/B18/failover.ts <renox-worker> <runs> <out.json>
//
// Per run: control/api (PGlite in memory) in its own process, sweeping every
// 5 s; two controlled renox-workers with a node listener each and a `file`
// replica in one shared directory (standing in for object storage); a free
// tenant whose function inserts a row per request. Writes go to the owning
// node for 10 s; that node is killed with SIGKILL; then:
//
//   rto_s  kill -> the other node answers the tenant with 200 (detection
//          FO1, restore FO3, route delta FO4, cell creation, first request)
//   rpo_s  time of the last acknowledged write -> time of the newest row in
//          the restored file (rows carry their insert time)
//   rows_lost  acknowledged ids above the restored file's max id

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { contentHash } from "../../../packages/artifact-validate/src/hash.ts";
import { summarize } from "../../lib/stats.ts";

const [worker, runsArg = "3", out] = process.argv.slice(2);
if (!worker || !out) {
  console.error("usage: bun bench/scenarios/B18/failover.ts <renox-worker> <runs> <out.json>");
  process.exit(2);
}
const runs = Number(runsArg);
const repo = join(import.meta.dir, "../../..");
const HOST = "b18.renox.test";
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

async function until<T>(what: string, ms: number, f: () => Promise<T | null>): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v !== null) return v;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** The artifact: GET /api/hits inserts a row (or, with ?write=0, reads the newest). */
function artifact(dir: string): { hash: string; tar: Buffer } {
  const migration = "create table app__hits (id integer primary key, at integer not null);\n";
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify({
      artifact: { version: 0 },
      app: { name: "b18", timezone: "UTC" },
      code: { format: "esm-dir", entry: { "functions/api/hits": "functions/api/hits.js" } },
      routes: [{ kind: "function", method: "GET", path: "/api/hits", module: "functions/api/hits", export: "GET" }],
      permissions: { network: [], secrets: [] },
    }),
    "code/functions/api/hits.js": `export async function GET({ url, db }) {
  if (url.searchParams.get("write") !== "0") {
    const r = await db.execute("insert into app__hits (at) values (?)", [Date.now()]);
    return Response.json({ id: Number(r.lastInsertRowid) });
  }
  const r = await db.queryOne("select coalesce(max(id), 0) as id, coalesce(max(at), 0) as at from app__hits");
  return Response.json(r);
}\n`,
    "migrations/app/001_hits.sql": migration,
    "migrations/checksums.json": JSON.stringify({ version: 0, files: { "app/001_hits.sql": sha256(migration) } }),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const hash = contentHash(new Map(Object.entries(files).map(([p, t]) => [p, new TextEncoder().encode(t)])));
  const tar = spawnSync("tar", ["-cf", "-", "-C", dir, "manifest.json", "code", "migrations"], { maxBuffer: 1 << 26 });
  if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`);
  return { hash, tar: tar.stdout as Buffer };
}

async function hits(port: number, write: boolean): Promise<{ id: number; at?: number } | null> {
  const r = await fetch(`http://127.0.0.1:${port}/api/hits${write ? "" : "?write=0"}`, { headers: { host: HOST }, signal: AbortSignal.timeout(2000) });
  if (r.status !== 200) return null;
  return (await r.json()) as { id: number; at?: number };
}

const rto: number[] = [];
const rpo: number[] = [];
const lost: number[] = [];
for (let run = 1; run <= runs; run++) {
  const procs: Bun.Subprocess[] = [];
  try {
    const root = mkdtempSync(join(tmpdir(), "renox-b18-"));
    const apiPort = await freePort();
    const nodePort = await freePort();
    const operator = `renox_op_${b32(32)}`;
    procs.push(
      Bun.spawn(["bun", join(repo, "control/api/src/main.ts")], {
        env: {
          ...process.env,
          CONTROL_DATABASE_URL: "pglite:memory",
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
    const api = `http://127.0.0.1:${apiPort}`;
    await until("the control API", 60_000, async () => ((await fetch(`${api}/v1/healthz`)).ok ? true : null));
    const op = (path: string, body: unknown) =>
      fetch(`${api}${path}`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = (await (await op("/v1/admin/tenants", { tenant_id: "t-b18", name: "b18", tier: "free" })).json()) as { token: { token: string } };
    const token = created.token.token;
    const workers: { node: string; port: number; proc: Bun.Subprocess }[] = [];
    for (const node of ["node-b18-1", "node-b18-2"]) {
      const dir = join(root, node);
      mkdirSync(dir, { recursive: true });
      const nodeToken = ((await (await op("/v1/admin/nodes", { node_id: node })).json()) as { token: string }).token;
      writeFileSync(join(dir, "node.token"), nodeToken, { mode: 0o600 });
      const port = await freePort();
      const listen = await freePort();
      const health = await freePort();
      writeFileSync(
        join(dir, "worker.toml"),
        `mode = "controlled"\nlisten = "127.0.0.1:${port}"\nnode_id = "${node}"\ndata_dir = "data"\nartifacts_dir = "artifacts"\nmeters_dir = "meters"\nlogs_dir = "logs"\nmeter_flush_ms = 200\nfetch_blocked_addresses = ["203.0.113.250"]\n[gateway]\nrate_limit_per_ip = 100000.0\nrate_limit_burst = 100000\nmax_connections_per_ip = 1000\n[control]\nurl = "http://127.0.0.1:${nodePort}"\nnode_token_file = "node.token"\nhealth_listen = "127.0.0.1:${health}"\nnode_listen = "127.0.0.1:${listen}"\n[sandbox]\nallow_unsandboxed = true\n[process]\nrun_dir = "run"\n[replication]\nenabled = true\nreplica = "file"\npath = "${join(root, "replica")}"\nsync_interval_ms = 1000\nstop_grace_ms = 3000\n`,
      );
      const proc = Bun.spawn([worker, "--config", join(dir, "worker.toml")], { stdout: "ignore", stderr: Bun.file(join(dir, "worker.log")) });
      procs.push(proc);
      workers.push({ node, port, proc });
      await until(`${node} healthy`, 60_000, async () => ((await fetch(`http://127.0.0.1:${health}/healthz`)).ok ? true : null));
    }
    const auth = { authorization: `Bearer ${token}` };
    await fetch(`${api}/v1/apps`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "b18" }) });
    const { hash, tar } = artifact(join(root, "artifact"));
    const up = await fetch(`${api}/v1/apps/b18/deployments`, { method: "POST", headers: { ...auth, "content-type": "application/x-tar", "x-renox-artifact-hash": hash }, body: tar });
    if (up.status !== 201 && up.status !== 200) throw new Error(`upload: ${up.status} ${await up.text()}`);
    const act = await fetch(`${api}/v1/apps/b18/activate`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ hash }) });
    if (act.status !== 200) throw new Error(`activate: ${act.status} ${await act.text()}`);
    // The owner is the worker that answers.
    const owner = await until("the owning node", 30_000, async () => {
      for (const w of workers) if ((await hits(w.port, false).catch(() => null)) !== null) return w;
      return null;
    });
    const other = workers.find((w) => w !== owner) as (typeof workers)[number];
    // 10 s of writes, then SIGKILL.
    let lastAck = 0;
    let lastAckAt = 0;
    const end = performance.now() + 10_000;
    while (performance.now() < end) {
      const r = await hits(owner.port, true).catch(() => null);
      if (r !== null) {
        lastAck = r.id;
        lastAckAt = Date.now();
      }
    }
    owner.proc.kill(9);
    const killed = performance.now();
    const restored = await until("the tenant served by the other node", 180_000, async () => hits(other.port, false));
    const rtoS = (performance.now() - killed) / 1000;
    const rpoS = Math.max(0, (lastAckAt - (restored.at ?? 0)) / 1000);
    rto.push(rtoS);
    rpo.push(rpoS);
    lost.push(Math.max(0, lastAck - restored.id));
    console.error(`B18 run ${run}/${runs}: RTO ${rtoS.toFixed(1)} s, RPO ${rpoS.toFixed(2)} s, ${lastAck - restored.id} rows lost (of ${lastAck})`);
  } finally {
    for (const p of procs) p.kill();
    await Promise.all(procs.map((p) => p.exited));
  }
}
const r = summarize(rto);
const p = summarize(rpo);
writeFileSync(
  out,
  JSON.stringify(
    {
      id: "B18",
      notes: "two controlled renox-workers on loopback, file replica in a shared directory, control/api sweeping every 5 s (unhealthy after 30 s); the owner killed with SIGKILL after 10 s of writes",
      samples: { rto_s: rto, rpo_s: rpo, rows_lost: lost },
      summary: { rto_s: r.max, rpo_s: p.max, rto_p50_s: r.p50, rpo_p50_s: p.p50 },
    },
    null,
    2,
  ),
);
