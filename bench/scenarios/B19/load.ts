// B19 load (#255): starts renox-worker twice per run (replication off, then
// on), drives GET /api/hits (one insert each) with a fixed number of
// concurrent clients for a fixed time, and writes the scenario JSON
// (bench/scenarios/README.md) with throughput_loss_pct = 100 * (1 - on/off)
// as the median of the runs.
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { contentHash } from "../../../packages/artifact-validate/src/hash.ts";
import { summarize } from "../../lib/stats.ts";

const [worker, runsArg, secondsArg, concArg, out] = process.argv.slice(2) as [string, string, string, string, string];
const runs = Number(runsArg);
const seconds = Number(secondsArg);
const concurrency = Number(concArg);

function artifact(dir: string): string {
  const migration = "create table app__hits (id integer primary key, at integer not null, pad text not null);\n";
  const sums = JSON.stringify({ version: 0, files: { "app/001_hits.sql": createHash("sha256").update(migration).digest("hex") } });
  const manifest = JSON.stringify({
    artifact: { version: 0 },
    app: { name: "b19", timezone: "UTC" },
    code: { format: "esm-dir", entry: { "functions/api/hits": "functions/api/hits.js" } },
    routes: [{ kind: "function", method: "GET", path: "/api/hits", module: "functions/api/hits", export: "GET" }],
    permissions: { network: [], secrets: [] },
  });
  const code = `export async function GET({ db }) {
  await db.execute("insert into app__hits (at, pad) values (?, ?)", [Date.now(), "x".repeat(200)]);
  return new Response("ok");
}\n`;
  const files: Record<string, string> = {
    "manifest.json": manifest,
    "code/functions/api/hits.js": code,
    "migrations/app/001_hits.sql": migration,
    "migrations/checksums.json": sums,
  };
  const hash = contentHash(new Map(Object.entries(files).map(([p, t]) => [p, new TextEncoder().encode(t)])));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, hash, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  return hash;
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop();
  return port;
}

async function once(replication: boolean): Promise<{ rps: number; p99_ms: number; lat: number[] }> {
  const root = mkdtempSync(join(tmpdir(), "renox-b19-"));
  const hash = artifact(join(root, "artifacts"));
  writeFileSync(join(root, "routes.json"), JSON.stringify({ version: 0, entries: [{ hostname: "b19.test", tenant_id: "t_b19", deployment_hash: hash, status: "active", updated_at: 1 }] }));
  const port = await freePort();
  const repl = replication ? `[replication]\nenabled = true\nreplica = "file"\npath = "replica"\nsync_interval_ms = 1000\n` : "";
  writeFileSync(
    join(root, "worker.toml"),
    `listen = "127.0.0.1:${port}"\ndata_dir = "data"\nartifacts_dir = "artifacts"\nroutes_file = "routes.json"\nmeters_dir = "meters"\nlogs_dir = "logs"\n[gateway]\nrate_limit_per_ip = 1000000.0\nrate_limit_burst = 1000000\nmax_connections_per_ip = 10000\n[process]\nrun_dir = "run"\n${repl}`,
  );
  const proc = Bun.spawn([worker, "--config", join(root, "worker.toml")], { stdout: "ignore", stderr: Bun.file(join(root, "worker.log")) });
  const base = `http://127.0.0.1:${port}/api/hits`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(base, { headers: { host: "b19.test" } })).ok) break;
    } catch {}
    await Bun.sleep(50);
  }
  // Warm-up, then the measurement.
  const lat: number[] = [];
  let count = 0;
  const run = async (until: number, record: boolean) => {
    while (performance.now() < until) {
      const t0 = performance.now();
      const r = await fetch(base, { headers: { host: "b19.test" } });
      await r.arrayBuffer();
      if (record && r.ok) {
        lat.push(performance.now() - t0);
        count++;
      }
    }
  };
  const warm = performance.now() + 3000;
  await Promise.all(Array.from({ length: concurrency }, () => run(warm, false)));
  const start = performance.now();
  const end = start + seconds * 1000;
  await Promise.all(Array.from({ length: concurrency }, () => run(end, true)));
  const elapsed = (performance.now() - start) / 1000;
  proc.kill();
  await proc.exited;
  const s = summarize(lat);
  return { rps: count / elapsed, p99_ms: s.p99, lat };
}

const off: number[] = [];
const on: number[] = [];
const p99Off: number[] = [];
const p99On: number[] = [];
for (let i = 0; i < runs; i++) {
  const a = await once(false);
  const b = await once(true);
  off.push(a.rps);
  on.push(b.rps);
  p99Off.push(a.p99_ms);
  p99On.push(b.p99_ms);
  console.error(`B19 run ${i + 1}/${runs}: off ${a.rps.toFixed(0)} req/s p99 ${a.p99_ms.toFixed(2)} ms; on ${b.rps.toFixed(0)} req/s p99 ${b.p99_ms.toFixed(2)} ms`);
}
const losses = off.map((o, i) => 100 * (1 - (on[i] as number) / o));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
writeFileSync(
  out,
  JSON.stringify(
    {
      id: "B19",
      notes: `closed loop, ${concurrency} clients, ${seconds} s per mode, one insert (≈ 230 bytes) per request; file replica, sync 1 s`,
      samples: { rps_off: off, rps_on: on, p99_off_ms: p99Off, p99_on_ms: p99On, throughput_loss_pct: losses },
      summary: { throughput_loss_pct: median(losses), rps_off: median(off), rps_on: median(on), p99_off_ms: median(p99Off), p99_on_ms: median(p99On) },
    },
    null,
    2,
  ),
);
