// heaptrack.sh's run (#641): N tenants of APP, one request each, then the
// worker is killed with SIGKILL so heaptrack records what was live.
// usage: bun heaptrack-run.ts   env: APP, N (run from the worktree's copy,
// so the harness starts the worktree's worker set-up)
import { Worker, sleep } from "../scenarios/B11/harness.ts";
const app = process.env.APP ?? "shop";
const n = Number(process.env.N ?? 100);
const PATH: Record<string, string> = { shop: "/api/products", hello: "/api/hello" };
const tenants = Array.from({ length: n }, (_, i) => ({ host: `${app}${i}.bench.test`, tenant: `t_${app}_${i}`, app }));
const w = await Worker.start(tenants);
await sleep(2000);
for (const t of tenants) {
  const r = await w.request(t.host, PATH[app]!);
  if (r.status !== 200) throw new Error(`${r.status} ${r.body}`);
}
await sleep(8000);
process.kill(w.pid, "SIGKILL");
console.log(`heaptrack-run: ${n} ${app} tenants, worker ${w.pid} killed`);
