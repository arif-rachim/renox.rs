// The shop's page loaders and action against a fake ctx (bun:sqlite with the
// real migration and seed). The B6 page runs exactly five queries for 100
// products; the search fragment (B7) one query for at most 20. Rendering is
// checked through the worker in shop.e2e.test.ts.
import { expect, test } from "bun:test";

import type { ActionContext, Db, LoaderContext } from "renox";

import "./fake-modules.ts";
import { ctx, fakeDb, shopDb } from "./fake-ctx.ts";

// Imported once `renox:modules` is registered (fake-modules.ts): the suite run
// from the repository root has no shop bunfig preload.
const { actions, load: detail } = await import("../pages/products/[id].ts");
const { load: list } = await import("../pages/products/index.ts");

const BASE = "https://shop.renox.test";
const SESSION = { id: "AAAAAAAAAAAAAAAAAAAAAA" };

/** A Db that counts statements: the "db stats" of a unit test. */
function counting(db: Db): { db: Db; count: () => number } {
  let n = 0;
  const wrap = <F extends (...a: never[]) => unknown>(f: F): F =>
    ((...a: Parameters<F>) => {
      n++;
      return f(...a);
    }) as F;
  return { db: { ...db, query: wrap(db.query), queryOne: wrap(db.queryOne), execute: wrap(db.execute) }, count: () => n };
}

function loaderCtx(sqlite: ReturnType<typeof shopDb>, path: string, fragment: string | null, params = {}): { c: LoaderContext; count: () => number } {
  const base = ctx(sqlite, "GET", `${BASE}${path}`, { params });
  const { db, count } = counting(base.db);
  return { c: { ...base, db, fragment, session: SESSION, setLocale: () => {} }, count };
}

test("B6: the products page loads 100 products with exactly five queries", async () => {
  const { c, count } = loaderCtx(shopDb(), "/products", null);
  const data = (await list(c)) as { products: unknown[]; categories: unknown[]; total: number; cart_count: number };
  expect(count()).toBe(5);
  expect(data.products).toHaveLength(100);
  expect(data.categories).toHaveLength(5);
  expect(data.total).toBe(100);
  expect(data.cart_count).toBe(0);
});

test("B7: the search fragment runs one query for at most 20 products", async () => {
  const { c, count } = loaderCtx(shopDb(), "/products?q=saffron", "product_list");
  const data = (await list(c)) as { products: { name: string }[] };
  expect(count()).toBe(1);
  expect(data.products).toHaveLength(8);
  const all = loaderCtx(shopDb(), "/products", "product_list");
  expect(((await list(all.c)) as { products: unknown[] }).products).toHaveLength(20);
  // LIKE wildcards in q are literal.
  const pct = loaderCtx(shopDb(), "/products?q=%25", "product_list");
  expect(((await list(pct.c)) as { products: unknown[] }).products).toHaveLength(0);
});

test("detail: product data, 404 Response for an unknown or malformed id", async () => {
  const sqlite = shopDb();
  const ok = (await detail(loaderCtx(sqlite, "/products/42", null, { id: "42" }).c)) as { product: { id: number; price: number; photo: unknown } };
  expect(ok.product.id).toBe(42);
  // No stored image before the seed's upload; then the key and dimensions <x-image> takes (#332).
  expect(ok.product.photo).toBeNull();
  sqlite.exec("update app__products set image = 'storage/products/coffee.png', image_width = 400, image_height = 400 where id = 42");
  const shown = (await detail(loaderCtx(sqlite, "/products/42", null, { id: "42" }).c)) as { product: { photo: unknown } };
  expect(shown.product.photo).toEqual({ key: "storage/products/coffee.png", width: 400, height: 400 });
  for (const id of ["4242", "0", "x", "1e3"]) {
    const r = await detail(loaderCtx(sqlite, `/products/${id}`, null, { id }).c);
    expect(r).toBeInstanceOf(Response);
    expect((r as Response).status).toBe(404);
  }
});

function actionCtx(sqlite: ReturnType<typeof shopDb>, id: string, quantity: string): ActionContext {
  const base = ctx(sqlite, "POST", `${BASE}/products/${id}?/addToCart`, { params: { id } });
  const form = new FormData();
  form.set("quantity", quantity);
  return { ...base, db: fakeDb(sqlite), action: "addToCart", form, fragment: "product", session: SESSION, setLocale: () => {} };
}

test("addToCart: inserts into the session's cart and names the cart badge fragment", async () => {
  const sqlite = shopDb();
  expect(await actions.addToCart(actionCtx(sqlite, "42", "2"))).toEqual({ added: 2, fragments: ["cart_badge"] });
  expect(sqlite.query("select cart_id, product_id, quantity from app__cart_items").all()).toEqual([
    { cart_id: SESSION.id, product_id: 42, quantity: 2 },
  ]);
  expect(await actions.addToCart(actionCtx(sqlite, "42", "0"))).toEqual({ error: "Quantity must be between 1 and 99." });
  // Product 1 has 37 in stock.
  expect(await actions.addToCart(actionCtx(sqlite, "1", "38"))).toEqual({ error: "Only 37 in stock." });
  expect(((await actions.addToCart(actionCtx(sqlite, "4242", "1"))) as Response).status).toBe(404);
});
