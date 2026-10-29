// The shop functions against a fake ctx (bun:sqlite with the real
// migration and seed). The same flows run through the worker in
// shop.e2e.test.ts.
import { expect, test } from "bun:test";

import { POST as cart } from "../functions/api/cart.ts";
import { POST as checkout } from "../functions/api/checkout.ts";
import { POST as seed } from "../functions/api/dev/seed.ts";
import { GET as detail } from "../functions/api/products/[id].ts";
import { GET as list } from "../functions/api/products/index.ts";
import { ctx, shopDb } from "./fake-ctx.ts";

const BASE = "https://shop.renox.test";

test("the seed has 100 deterministic products in five categories", () => {
  const db = shopDb();
  expect(db.query("select count(*) as n from app__products").get()).toEqual({ n: 100 });
  expect(db.query("select count(distinct category) as n from app__products").get()).toEqual({ n: 5 });
  expect(db.query("select name, price_fils from app__products where id = 1").get()).toEqual({
    name: "Medjool Dates 250 g",
    price_fils: 9419,
  });
});

test("list, search, category filter; LIKE wildcards in q are literal", async () => {
  const db = shopDb();
  const all = await (await list(ctx(db, "GET", `${BASE}/api/products`))).json();
  expect(all.count).toBe(100);
  const dates = await (await list(ctx(db, "GET", `${BASE}/api/products?q=medjool`))).json();
  expect(dates.count).toBe(4);
  expect(dates.products.every((p: { name: string }) => p.name.startsWith("Medjool"))).toBe(true);
  const coffee = await (await list(ctx(db, "GET", `${BASE}/api/products?category=coffee`))).json();
  expect(coffee.count).toBe(20);
  expect((await (await list(ctx(db, "GET", `${BASE}/api/products?q=%25`))).json()).count).toBe(0);
  expect((await list(ctx(db, "GET", `${BASE}/api/products?category=cars`))).status).toBe(400);
});

test("detail and 404", async () => {
  const db = shopDb();
  const r = await detail(ctx(db, "GET", `${BASE}/api/products/7`, { params: { id: "7" } }));
  expect((await r.json()).id).toBe(7);
  expect((await detail(ctx(db, "GET", `${BASE}/api/products/999`, { params: { id: "999" } }))).status).toBe(404);
  expect((await detail(ctx(db, "GET", `${BASE}/api/products/x`, { params: { id: "x" } }))).status).toBe(400);
});

test("add to cart: zod validation, stock check, totals", async () => {
  const db = shopDb();
  const add = (body: unknown) => cart(ctx(db, "POST", `${BASE}/api/cart`, { body }));
  const r = await add({ cart_id: "c_1", product_id: 1, quantity: 2 });
  expect(r.status).toBe(201);
  expect((await r.json()).cart).toEqual({ items: 1, total_fils: 2 * 9419 });
  expect((await add({ cart_id: "c_1", product_id: 1, quantity: 0 })).status).toBe(400);
  expect((await add({ cart_id: "c 1", product_id: 1, quantity: 1 })).status).toBe(400);
  expect((await add({ cart_id: "c_1", product_id: 1, quantity: 1, extra: true })).status).toBe(400);
  expect((await add({ cart_id: "c_1", product_id: 999, quantity: 1 })).status).toBe(404);
  // Product 1 has 37 in stock; 2 are in the cart.
  expect((await add({ cart_id: "c_1", product_id: 1, quantity: 36 })).status).toBe(409);
});

test("checkout needs a user (auth, #241); signed in it builds a Stripe PaymentIntent request without network", async () => {
  const db = shopDb();
  const signedOut = await checkout(ctx(db, "POST", `${BASE}/api/checkout`, { body: { cart_id: "c_2" } }));
  expect(signedOut.status).toBe(401);
  (globalThis as { __shopTestUser?: unknown }).__shopTestUser = { id: "u_test", email: "t@example.com", display_name: "T", created_at: 1 };
  await cart(ctx(db, "POST", `${BASE}/api/cart`, { body: { cart_id: "c_2", product_id: 2, quantity: 1 } }));
  const r = await checkout(ctx(db, "POST", `${BASE}/api/checkout`, { body: { cart_id: "c_2" } }));
  const body = await r.json();
  expect(body.amount).toBe(17338);
  expect(body.currency).toBe("aed");
  expect(body.payment_intent.metadata).toEqual({ cart_id: "c_2", items: "1" });
  expect(body.sdk.create).toBe("function");
  expect((await checkout(ctx(db, "POST", `${BASE}/api/checkout`, { body: { cart_id: "none" } }))).status).toBe(404);
  expect(db.query("select user_id, org_id, cart_id from app__orders").all()).toEqual([{ user_id: "u_test", org_id: null, cart_id: "c_2" }]);
  // With an active organisation (the org module, #242) the order carries it.
  (globalThis as { __shopTestOrg?: unknown }).__shopTestOrg = { id: "o_test", slug: "t", name: "T", role: "member", scope: { org_id: "o_test", role: "member" } };
  expect((await checkout(ctx(db, "POST", `${BASE}/api/checkout`, { body: { cart_id: "c_2" } }))).status).toBe(200);
  expect(db.query("select org_id from app__orders order by id").all()).toEqual([{ org_id: null }, { org_id: "o_test" }]);
  delete (globalThis as { __shopTestUser?: unknown }).__shopTestUser;
  delete (globalThis as { __shopTestOrg?: unknown }).__shopTestOrg;
});

test("the seed endpoint is dev only and idempotent", async () => {
  const db = shopDb(false);
  expect((await seed(ctx(db, "POST", `${BASE}/api/dev/seed`))).status).toBe(404);
  expect(await (await seed(ctx(db, "POST", "http://shop.localhost/api/dev/seed"))).json()).toEqual({ products: 100 });
  expect(await (await seed(ctx(db, "POST", "http://shop.localhost/api/dev/seed"))).json()).toEqual({ products: 100 });
});
