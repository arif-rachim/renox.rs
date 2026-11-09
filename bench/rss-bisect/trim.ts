// #457: how much of the per-isolate RSS is free glibc memory that malloc
// keeps. Warms N tenants of APP (one request each), samples RSS, calls
// malloc_trim(0) in the worker through gdb, and samples again.
// usage: bun trim.ts <out.json>   env: APP (shop), N (100), RENOX_WORKER_PATH
// Run by regions.sh with RUN_TS=trim.ts; needs gdb and ptrace rights.
import { writeFileSync } from "node:fs";
import { Worker, round, sleep } from "../scenarios/B11/harness.ts";

const out = process.argv[2]!;
const app = process.env.APP ?? "shop";
const n = Number(process.env.N ?? 100);
const PATH: Record<string, string> = { shop: "/api/products", hello: "/api/hello" };

const trim = (pid: number): void => {
  const p = Bun.spawnSync(["gdb", "-p", String(pid), "-batch", "-ex", "call (int) malloc_trim(0)"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`gdb: ${p.stderr.toString()}`);
};

const tenants = Array.from({ length: n }, (_, i) => ({ host: `${app}${i}.bench.test`, tenant: `t_${app}_${i}`, app }));
const w = await Worker.start(tenants);
try {
  await sleep(2000);
  const base = w.memory().rss_mb;
  trim(w.pid);
  await sleep(1000);
  const baseTrimmed = w.memory().rss_mb;
  for (const t of tenants) {
    const r = await w.request(t.host, PATH[app]!);
    if (r.status !== 200) throw new Error(`${r.status} ${r.body}`);
  }
  await sleep(5000);
  const warm = w.memory().rss_mb;
  trim(w.pid);
  await sleep(1000);
  const warmTrimmed = w.memory().rss_mb;
  const res = {
    app,
    n,
    // Same shape as regions.ts, so regions.sh takes the median per key.
    per_isolate_mb: {
      before_trim: round((warm - base) / n),
      after_trim: round((warmTrimmed - baseTrimmed) / n),
      trimmed: round((warm - warmTrimmed - (base - baseTrimmed)) / n),
    },
    total_mb: round((warmTrimmed - baseTrimmed) / n),
    threads_per_isolate: 0,
  };
  console.log(JSON.stringify(res, null, 2));
  writeFileSync(out, JSON.stringify(res, null, 2));
} finally {
  w.stop();
}
