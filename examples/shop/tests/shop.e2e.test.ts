// The shop under `renox dev` on the real worker: seed, list 100, search,
// detail, add to cart, checkout. Runs only when RENOX_WORKER_PATH is set
// (cargo build -p renox-cell --bin renox-worker).
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../../../cli/src/commands/check.ts";
import { startDev } from "../../../cli/src/commands/dev.ts";
import { buildArtifact } from "../../../cli/src/lib/build.ts";
import { hashDir } from "../../../cli/src/lib/hash.ts";

const worker = process.env.RENOX_WORKER_PATH;
const app = join(import.meta.dir, "..");

test("renox build: valid artifact with migrations and checksums; renox check passes", async () => {
  const out = mkdtempSync(join(tmpdir(), "renox-shop-build-"));
  const r = await buildArtifact(app, out);
  expect(hashDir(r.dir)).toBe(r.hash);
  expect(readdirSync(join(r.dir, "migrations/app"))).toEqual(["001_init.sql"]);
  expect(r.manifest.routes.map((x) => `${x.kind === "function" ? x.method : "PAGE"} ${x.path}`).sort()).toEqual([
    "GET /api/products",
    "GET /api/products/:id",
    "POST /api/cart",
    "POST /api/checkout",
    "POST /api/dev/seed",
  ]);
  expect(await check(app)).toEqual({ errors: [], findings: [] });
});

test.skipIf(!worker)(
  "under renox dev: seed, list 100, search, detail, add to cart, checkout",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-shop-dev-"));
    cpSync(app, dir, { recursive: true, filter: (p) => !/\/(node_modules|\.renox|tests)(\/|$)/u.test(p.slice(app.length)) });
    // Bare imports (zod, stripe) resolve from the workspace's node_modules.
    cpSync(join(app, "node_modules"), join(dir, "node_modules"), { recursive: true, dereference: true });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const dev = await startDev({ project: dir, port, log: () => {} });
    const base = `http://localhost:${port}`;
    const post = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      expect(await (await post("/api/dev/seed")).json()).toEqual({ products: 100 });
      const all = await (await fetch(`${base}/api/products`)).json();
      expect(all.count).toBe(100);
      expect((await (await fetch(`${base}/api/products?q=saffron`)).json()).count).toBe(8);
      const one = await (await fetch(`${base}/api/products/42`)).json();
      expect(one.id).toBe(42);
      expect((await fetch(`${base}/api/products/4242`)).status).toBe(404);
      const added = await post("/api/cart", { cart_id: "c_e2e", product_id: 42, quantity: 3 });
      expect(added.status).toBe(201);
      expect((await added.json()).cart.total_fils).toBe(3 * one.price_fils);
      expect((await post("/api/cart", { cart_id: "c_e2e", product_id: "42", quantity: 3 })).status).toBe(400);
      const co = await (await post("/api/checkout", { cart_id: "c_e2e" })).json();
      expect(co.amount).toBe(3 * one.price_fils);
      expect(co.currency).toBe("aed");
    } finally {
      await dev.stop();
    }
  },
  120_000,
);
