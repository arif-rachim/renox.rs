// The shop under `renox dev` on the real worker: seed, list 100, search,
// detail, add to cart, checkout, through the API and through the pages
// (#45: B6 page 20-30 KB with 100 items and five queries, the search
// fragment, the addToCart action with the out-of-band cart badge). Runs
// only when RENOX_WORKER_PATH is set (cargo build -p renox-cell --bin
// renox-worker): the shop has templates, which `renox-worker transpile`
// compiles (#43).
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

test.skipIf(!worker)("renox build: valid artifact with migrations, checksums, pages, templates; renox check passes", async () => {
  const out = mkdtempSync(join(tmpdir(), "renox-shop-build-"));
  const r = await buildArtifact(app, out);
  expect(hashDir(r.dir)).toBe(r.hash);
  expect(readdirSync(join(r.dir, "migrations/app"))).toEqual(["001_init.sql"]);
  expect(r.manifest.routes.map((x) => `${x.kind === "function" ? x.method : "PAGE"} ${x.path}`).sort()).toEqual([
    "GET /api/products",
    "GET /api/products/:id",
    "PAGE /",
    "PAGE /products",
    "PAGE /products/:id",
    "POST /api/cart",
    "POST /api/checkout",
    "POST /api/dev/seed",
  ]);
  expect(r.manifest.templates?.["pages/products/index"]).toEqual({ kind: "page", fragments: { cart_badge: { target: "cart-badge" }, product_list: { target: "product-list" } } });
  expect(r.manifest.templates?.["pages/products/[id]"]?.fragments).toEqual({ cart_badge: { target: "cart-badge" }, product: { target: "product" } });
  expect(readdirSync(join(r.dir, "public"))).toEqual(["app.css", "htmx-2.0.4.min.js"]);
  // renox check: no template diagnostics, no lint findings.
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

      // Pages (#45). B6: the list page, 100 items, 20-30 KB.
      const page = await fetch(`${base}/products`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html.match(/<article class="card">/gu)?.length).toBe(100);
      const kb = new TextEncoder().encode(html).length / 1024;
      expect(kb).toBeGreaterThanOrEqual(20);
      expect(kb).toBeLessThanOrEqual(30);
      const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0] as string);
      const jar = cookies.join("; ");
      const token = (cookies.find((c) => c.startsWith("__Host-renox_csrf=")) ?? "").split("=")[1] ?? "";
      expect(token.length).toBeGreaterThan(20);

      // B7: the search box's fragment request, one block.
      const frag = await (await fetch(`${base}/products?q=saffron`, { headers: { "hx-request": "true", "hx-target": "product-list", cookie: jar } })).text();
      expect(frag.startsWith('<ul id="product-list" class="grid">')).toBe(true);
      expect(frag.match(/<article class="card">/gu)?.length).toBe(8);
      expect(frag).not.toContain("<html");

      // Detail.
      const detail = await (await fetch(`${base}/products/42`, { headers: { cookie: jar } })).text();
      expect(detail).toContain(`>${one.name}</h1>`);
      expect(detail).toContain(`name="_csrf" value="${token}"`);
      expect((await fetch(`${base}/products/4242`)).status).toBe(404);

      // addToCart through htmx: the product fragment, then the badge out of band.
      const add = await fetch(`${base}/products/42?/addToCart`, {
        method: "POST",
        headers: { cookie: jar, "content-type": "application/x-www-form-urlencoded", "hx-request": "true", "hx-target": "product" },
        body: `_csrf=${token}&quantity=2`,
      });
      expect(add.status).toBe(200);
      const swapped = await add.text();
      expect(swapped.startsWith('<article id="product">')).toBe(true);
      expect(swapped).toContain("Added 2 to your cart.");
      expect(swapped).toContain('<span hx-swap-oob="true" id="cart-badge" dir="auto">2</span>');
      // Without the token: 403, nothing added.
      const forged = await fetch(`${base}/products/42?/addToCart`, {
        method: "POST",
        headers: { cookie: jar, "content-type": "application/x-www-form-urlencoded" },
        body: "quantity=5",
      });
      expect(forged.status).toBe(403);
      // A plain form POST gets the full page; the badge counts the session's cart.
      const plain = await (await fetch(`${base}/products/42?/addToCart`, {
        method: "POST",
        headers: { cookie: jar, "content-type": "application/x-www-form-urlencoded" },
        body: `_csrf=${token}&quantity=1`,
      })).text();
      expect(plain).toContain("<!DOCTYPE html>");
      expect(plain).toContain('<span id="cart-badge" dir="auto">3</span>');

      // The meter: the B6 page read 108 rows (100 products, 5 categories, 3 single rows).
      const meters = join(dir, ".renox/meters");
      let rec: { db_rows: number; render_fuel: number } | undefined;
      for (let i = 0; i < 100 && !rec; i++) {
        await Bun.sleep(50);
        for (const f of readdirSync(meters).filter((n) => n.endsWith(".ndjson")))
          for (const line of (await Bun.file(join(meters, f)).text()).split("\n").filter(Boolean))
            for (const r of (JSON.parse(line) as { records: { route: string; http_status: number; db_rows: number; render_fuel: number }[] }).records)
              if (r.route === "GET /products" && r.db_rows > 100 && r.http_status === 200) rec = r;
      }
      expect(rec?.db_rows).toBe(108);
      expect(rec?.render_fuel).toBeGreaterThan(0);
    } finally {
      await dev.stop();
    }
  },
  120_000,
);
