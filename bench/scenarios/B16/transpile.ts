// #43: which transpiler path does `renox build` use? Cold cost of one
// compile of the shop templates (crates/renox-template/tests/fixtures/shop)
// through each path, nothing cached between iterations:
//
// - wasm:   read renox_template.wasm, WebAssembly.compile + instantiate,
//           renox_compile (the CLI's first compile in a fresh process);
// - worker: spawn `renox-worker transpile`, write stdin, read stdout.
//
// Usage: bun bench/scenarios/B16/transpile.ts <renox_template.wasm> <renox-worker> [iterations]
// Build the Wasm module with bench/scenarios/B16/build-wasm.sh.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { summarize } from "../../lib/stats.ts";

const [wasmPath, workerPath, n = "30"] = process.argv.slice(2);
if (!wasmPath || !workerPath) {
  console.error("usage: bun bench/scenarios/B16/transpile.ts <renox_template.wasm> <renox-worker> [iterations]");
  process.exit(2);
}

const fixture = join(import.meta.dir, "../../../crates/renox-template/tests/fixtures/shop");
const files: Record<string, string> = {};
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(fixture, p)] = readFileSync(p, "utf8");
  }
};
walk(fixture);
const input = JSON.stringify({ files });

async function viaWasm(): Promise<string> {
  const bytes = readFileSync(wasmPath as string);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as {
    memory: WebAssembly.Memory;
    renox_alloc(len: number): number;
    renox_free(ptr: number, len: number): void;
    renox_compile(ptr: number, len: number): number;
  };
  const inBytes = new TextEncoder().encode(input);
  const ptr = ex.renox_alloc(inBytes.length);
  new Uint8Array(ex.memory.buffer, ptr, inBytes.length).set(inBytes);
  const out = ex.renox_compile(ptr, inBytes.length);
  const len = new DataView(ex.memory.buffer).getUint32(out, true);
  const text = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, out + 4, len));
  ex.renox_free(ptr, inBytes.length);
  ex.renox_free(out, len + 4);
  return text;
}

async function viaWorker(): Promise<string> {
  const p = Bun.spawn([workerPath as string, "transpile"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  p.stdin.write(input);
  await p.stdin.end();
  const text = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error("renox-worker transpile failed");
  return text;
}

const a = await viaWasm();
const b = await viaWorker();
// Same result; key order may differ (serde_json features differ per target).
if (!Bun.deepEquals(JSON.parse(a), JSON.parse(b))) throw new Error("the two paths disagree");
if (!JSON.parse(a).ok) throw new Error(`shop does not compile: ${a}`);

const samples: Record<string, number[]> = { wasm_ms: [], worker_ms: [] };
for (let i = 0; i < Number(n); i++) {
  for (const [key, f] of [
    ["wasm_ms", viaWasm],
    ["worker_ms", viaWorker],
  ] as const) {
    const t0 = performance.now();
    await f();
    samples[key]?.push(performance.now() - t0);
  }
}
const wasmBytes = statSync(wasmPath).size;
const workerBytes = statSync(workerPath).size;
console.log(
  JSON.stringify(
    {
      files: Object.keys(files).length,
      input_bytes: input.length,
      wasm_bytes: wasmBytes,
      worker_bytes: workerBytes,
      wasm: summarize(samples.wasm_ms ?? []),
      worker: summarize(samples.worker_ms ?? []),
    },
    null,
    2,
  ),
);
