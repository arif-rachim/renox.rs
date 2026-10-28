// B16 (docs/14-benchmarks.md): edit one template, browser updated, ≤ 300 ms.
// Usage: bun bench/scenarios/B16/dev-loop.ts <runs> <out.json>
// Each run: 20 edits of pages/products/index.html in a fresh copy of
// examples/shop under `renox dev`. update_ms = file write -> `templates`
// event received on /__renox/dev/events -> fragment response (HX-Target
// product-list) carrying the new text. That is what the dev client does
// before it swaps the element; the DOM swap itself is not timed.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDev } from "../../../cli/src/commands/dev.ts";
import { summarize } from "../../lib/stats.ts";

const [runsArg = "3", out] = process.argv.slice(2);
if (!out) {
  console.error("usage: bun bench/scenarios/B16/dev-loop.ts <runs> <out.json>");
  process.exit(2);
}
const repo = join(import.meta.dir, "../../..");
const EDITS = 20;
const TEMPLATE = "pages/products/index.html";

const samples: number[] = [];
for (let run = 0; run < Number(runsArg); run++) {
  const dir = mkdtempSync(join(tmpdir(), "renox-b16-"));
  cpSync(join(repo, "examples/shop"), dir, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".renox") });
  // Bare imports (zod, stripe) resolve from the workspace's node_modules.
  cpSync(join(repo, "examples/shop/node_modules"), join(dir, "node_modules"), { recursive: true, dereference: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dev = await startDev({ project: dir, port, log: () => {} });
  const base = `http://localhost:${port}`;
  const ctl = new AbortController();
  const res = await fetch(`${base}/__renox/dev/events`, { signal: ctl.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const nextTemplates = async (): Promise<void> => {
    for (;;) {
      const i = buf.indexOf("event: templates");
      if (i >= 0) {
        const end = buf.indexOf("\n\n", i);
        if (end >= 0) {
          buf = buf.slice(end + 2);
          return;
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream closed");
      buf += dec.decode(value);
    }
  };
  try {
    const file = join(dir, TEMPLATE);
    const original = readFileSync(file, "utf8");
    if (!original.includes('r-fragment="product_list"')) throw new Error(`${TEMPLATE} has no product_list fragment`);
    // Warm-up: first request creates the cell.
    await (await fetch(`${base}/products`)).text();
    for (let n = 0; n < EDITS; n++) {
      const text = `edit-${run}-${n}`;
      const edited = original.replace(/(<ul[^>]*r-fragment="product_list"[^>]*>)/u, `$1<li class="b16">${text}</li>`);
      if (edited === original) throw new Error("could not place the edit inside the product_list fragment");
      const t0 = performance.now();
      writeFileSync(file, edited);
      await nextTemplates();
      const frag = await (await fetch(`${base}/products`, { headers: { "hx-request": "true", "hx-target": "product-list" } })).text();
      if (!frag.includes(text)) throw new Error(`fragment does not show the edit: ${frag.slice(0, 200)}`);
      samples.push(performance.now() - t0);
      await Bun.sleep(50);
    }
  } finally {
    ctl.abort();
    await dev.stop();
  }
}

const s = summarize(samples);
await Bun.write(
  out,
  `${JSON.stringify(
    {
      id: "B16",
      notes: `renox dev on examples/shop; ${EDITS} template edits per run; worker ${process.env.RENOX_WORKER_PATH}`,
      samples: { update_ms: samples },
      summary: { update_ms: s.p50, p50_ms: s.p50, p99_ms: s.p99 },
    },
    null,
    2,
  )}\n`,
);
console.log(`B16 update_ms p50 ${s.p50.toFixed(1)} p99 ${s.p99.toFixed(1)} (n=${samples.length})`);
