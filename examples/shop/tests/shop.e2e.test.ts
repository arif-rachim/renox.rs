// The shop on the real worker through `renox/test` (#238; was `renox dev`
// by hand): seed, list 100, search,
// detail, add to cart, checkout, through the API and through the pages
// (#45: B6 page 20-30 KB with 100 items and five queries, the search
// fragment, the addToCart action with the out-of-band cart badge). Runs
// only when RENOX_WORKER_PATH is set (cargo build -p renox-cell --bin
// renox-worker): the shop has templates, which `renox-worker transpile`
// compiles (#43).
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../../../cli/src/commands/check.ts";
import { buildArtifact } from "../../../cli/src/lib/build.ts";
import { hashDir } from "../../../cli/src/lib/hash.ts";
import { app as harness } from "renox/test";

const worker = process.env.RENOX_WORKER_PATH;
const app = join(import.meta.dir, "..");

test.skipIf(!worker)("renox build: valid artifact with migrations, checksums, pages, templates; renox check passes", async () => {
  const out = mkdtempSync(join(tmpdir(), "renox-shop-build-"));
  const r = await buildArtifact(app, out);
  expect(hashDir(r.dir)).toBe(r.hash);
  expect(readdirSync(join(r.dir, "migrations/app")).sort()).toEqual(["001_init.sql", "002_orders.sql", "003_orders_org.sql", "004_refunds.sql"]);
  // auth (#241): its migrations before the app's, its pages under /auth.
  expect(readdirSync(join(r.dir, "migrations/auth")).sort()).toEqual(["001_init.sql", "002_tokens_user_agent.sql", "003_agents.sql", "004_phone_passkeys_uaepass.sql", "005_login_tickets.sql"]);
  // org (#242): after auth, its dependency; its pages under /org.
  expect(readdirSync(join(r.dir, "migrations/org")).sort()).toEqual(["001_init.sql", "002_orgs_locale.sql"]);
  // i18n (#244): first, auth and org depend on it; the shop's catalogs under code/i18n/.
  expect(r.manifest.modules?.map((m) => m.name)).toEqual(["audit", "i18n", "auth", "billing", "email", "notifications", "org", "storage", "tax_gcc", "twofa"]);
  expect(readdirSync(join(r.dir, "code/i18n")).sort()).toEqual(["ar.json", "en.json"]);
  expect(r.manifest.routes.map((x) => `${x.kind === "function" ? x.method : x.kind === "page" ? "PAGE" : x.kind.toUpperCase()} ${"path" in x ? x.path : x.name}`).sort()).toEqual([
    "GET /api/products",
    "GET /api/products/:id",
    "GET /auth/oauth/:provider/callback",
    "GET /auth/oauth/:provider/start",
    "GET /auth/oauth/authorize",
    "JOB prune",
    "PAGE /",
    "PAGE /2fa",
    "PAGE /2fa/enroll/passkey",
    "PAGE /2fa/enroll/totp",
    "PAGE /2fa/recovery",
    "PAGE /2fa/verify",
    "PAGE /auth/account",
    "PAGE /auth/login",
    "PAGE /auth/magic",
    "PAGE /auth/magic/:token",
    "PAGE /auth/oauth/consent",
    "PAGE /auth/passkeys/login",
    "PAGE /auth/passkeys/register",
    "PAGE /auth/phone",
    "PAGE /auth/phone/verify",
    "PAGE /auth/register",
    "PAGE /auth/reset",
    "PAGE /auth/reset/confirm",
    "PAGE /billing",
    "PAGE /billing/checkout/import",
    "PAGE /billing/checkout/pending",
    "PAGE /billing/invoices",
    "PAGE /email",
    "PAGE /files",
    "PAGE /notifications",
    "PAGE /notifications/prefs",
    "PAGE /orders",
    "PAGE /orders/live",
    "PAGE /org",
    "PAGE /org/accept/:token",
    "PAGE /org/members",
    "PAGE /products",
    "PAGE /products/:id",
    "PAGE /tax",
    "PAGE /tax/invoices/:number",
    "POST /api/cart",
    "POST /api/checkout",
    "POST /api/dev/seed",
    "POST /auth/oauth/register",
    "POST /auth/oauth/token",
    "SSE /notifications/sse/notifications",
    "SSE /sse/orders",
    "TOOL invite_member",
    "WEBHOOK /billing/webhooks/stripe",
    "WEBHOOK /email/webhooks/feedback",
  ]);
  expect(r.manifest.templates?.["pages/products/index"]).toEqual({ kind: "page", fragments: { cart_badge: { target: "cart-badge" }, product_list: { target: "product-list" } } });
  expect(r.manifest.templates?.["pages/products/[id]"]?.fragments).toEqual({ cart_badge: { target: "cart-badge" }, product: { target: "product" } });
  expect(readdirSync(join(r.dir, "public")).sort()).toEqual(["app.css", "htmx-2.0.4.min.js"]);
  // renox check: no template diagnostics, no lint findings.
  expect(await check(app)).toEqual({ errors: [], findings: [] });
});

test.skipIf(!worker)(
  "under renox test (#238): seed, list 100, search, detail, add to cart, checkout",
  async () => {
    // The same prebuilt worker as `renox dev`, on a temporary tenant file.
    const t = await harness({ project: app });
    const post = (path: string, body?: unknown) => t.request("POST", path, body === undefined ? {} : { body: body as Record<string, unknown> });
    const get = (path: string, headers: Record<string, string> = {}) => t.request("GET", path, { headers });
    expect((await post("/api/dev/seed")).json()).toEqual({ products: 100 });
    const all = (await get("/api/products")).json<{ count: number }>();
    expect(all.count).toBe(100);
    expect((await get("/api/products?q=saffron")).json<{ count: number }>().count).toBe(8);
    const one = (await get("/api/products/42")).json<{ id: number; name: string; price_fils: number }>();
    expect(one.id).toBe(42);
    expect((await get("/api/products/4242")).status).toBe(404);
    const added = await post("/api/cart", { cart_id: "c_e2e", product_id: 42, quantity: 3 });
    expect(added.status).toBe(201);
    expect(added.json<{ cart: { total_fils: number } }>().cart.total_fils).toBe(3 * one.price_fils);
    expect((await post("/api/cart", { cart_id: "c_e2e", product_id: "42", quantity: 3 })).status).toBe(400);
    // Checkout needs a user (auth, #241): 401, then sign up through auth's page and check out.
    expect((await post("/api/checkout", { cart_id: "c_e2e" })).status).toBe(401);
    const buyer = t.as("buyer");
    expect((await buyer.action("/auth/register", "default", { email: "buyer@example.com", password: "correct horse battery", display_name: "Buyer" })).status).toBe(200);
    expect((await buyer.action("/auth/login", "default", { email: "buyer@example.com", password: "correct horse battery" })).status).toBe(303);
    const co = (await buyer.request("POST", "/api/checkout", { body: { cart_id: "c_e2e" } })).json<{ amount: number; currency: string; order_id: number }>();
    expect(co.amount).toBe(3 * one.price_fils);
    expect(co.currency).toBe("aed");
    const order = t.db.query<{ user_id: string }>("select user_id from app__orders where id = ?", [co.order_id])[0];
    expect(order?.user_id).toBe(t.db.query<{ id: string }>("select id from auth__public_users_v1 where email = 'buyer@example.com'")[0]?.id as string);
    expect(t.db.query<{ org_id: string | null }>("select org_id from app__orders where id = ?", [co.order_id])[0]?.org_id).toBeNull();
    // The header's user menu, through the app.header slot.
    expect((await buyer.page("/products/42")).html).toContain('<a href="/auth/account" dir="auto">Buyer</a>');
    // With an organisation (org, #242): the order carries the active one; the header shows the switcher.
    expect((await buyer.action("/org", "create", { name: "Buyer Trading LLC", slug: "" })).status).toBe(303);
    const orgId = t.db.query<{ org_id: string }>("select org_id from org__public_members_v1")[0]?.org_id as string;
    const co2 = (await buyer.request("POST", "/api/checkout", { body: { cart_id: "c_e2e" } })).json<{ order_id: number }>();
    expect(t.db.query<{ org_id: string }>("select org_id from app__orders where id = ?", [co2.order_id])[0]?.org_id).toBe(orgId);
    const header = (await buyer.page("/products/42")).html;
    expect(header).toContain('action="/org?/switch"');
    expect(header).toContain("Buyer Trading LLC · owner");

    // Pages (#45). B6: the list page, 100 items, 20-30 KB. `page` keeps the session's cookies.
    const page = await t.page("/products");
    expect(page.status).toBe(200);
    const html = page.html;
    expect(html.match(/<article class="card">/gu)?.length).toBe(100);
    const kb = new TextEncoder().encode(html).length / 1024;
    expect(kb).toBeGreaterThanOrEqual(20);
    expect(kb).toBeLessThanOrEqual(30);
    const token = (page.headers.getSetCookie().map((c) => c.split(";")[0] as string).find((c) => c.startsWith("__Host-renox_csrf=")) ?? "").split("=")[1] ?? "";
    expect(token.length).toBeGreaterThan(20);

    // Arabic (i18n, #244): the list page with ?lang=ar is rtl, from the
    // shop's catalog, and stays Arabic for this session without ?lang=.
    const ar = t.as("arabic");
    const arPage = await ar.page("/products?lang=ar");
    expect(arPage.html).toContain('<html lang="ar" dir="rtl">');
    expect(arPage.html).toContain("<h1>المنتجات</h1>");
    expect(arPage.html).toContain('<a href="/products?lang=en" lang="en">English</a>');
    // Digits: latin (the config default); money in Arabic order with the dirham sign.
    expect(arPage.html).toMatch(/<span class="price" dir="auto">[0-9.,]+\sد\.إ\.<\/span>/u);
    expect((await ar.page("/products/42")).html).toContain('<html lang="ar" dir="rtl">');
    expect((await t.as("english").page("/products")).html).toContain('<html lang="en" dir="ltr">');

    // B7: the search box's fragment request, one block.
    const frag = (await get("/products?q=saffron", { "hx-request": "true", "hx-target": "product-list" })).html;
    expect(frag.startsWith('<ul id="product-list" class="grid">')).toBe(true);
    expect(frag.match(/<article class="card">/gu)?.length).toBe(8);
    expect(frag).not.toContain("<html");

    // Detail.
    const detail = (await t.page("/products/42")).html;
    expect(detail).toContain(`>${one.name}</h1>`);
    // The form carries the token masked for this response (BREACH, #111),
    // never the cookie's bytes; the masked value is what a browser posts.
    const rendered = /name="_csrf" value="([^"]+)"/u.exec(detail)?.[1] ?? "";
    expect(rendered.length).toBe(86);
    expect(detail).not.toContain(token);
    expect((await get("/products/4242")).status).toBe(404);

    // addToCart through htmx: the product fragment, then the badge out of band.
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const add = await t.request("POST", "/products/42?/addToCart", { headers: { ...form, "hx-request": "true", "hx-target": "product" }, body: `_csrf=${rendered}&quantity=2` });
    expect(add.status).toBe(200);
    expect(add.html.startsWith('<article id="product">')).toBe(true);
    expect(add.html).toContain("Added 2 to your cart.");
    expect(add.html).toContain('<span hx-swap-oob="true" id="cart-badge" dir="auto">2</span>');
    // Without the token: 403, nothing added.
    expect((await t.request("POST", "/products/42?/addToCart", { headers: form, body: "quantity=5" })).status).toBe(403);
    // A plain form POST gets the full page; the badge counts the session's cart.
    const plain = (await t.action("/products/42", "addToCart", { quantity: "1" })).html;
    expect(plain).toContain("<!DOCTYPE html>");
    expect(plain).toContain('<span id="cart-badge" dir="auto">3</span>');

    // The meter: the B6 page read 108 rows (100 products, 5 categories, 3 single rows).
    let rec: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !rec; i++) {
      await Bun.sleep(50);
      rec = t.meters().find((r) => r.route === "GET /products" && (r.db_rows as number) > 100 && r.http_status === 200);
    }
    expect(rec?.db_rows).toBe(108);
    expect(rec?.render_fuel as number).toBeGreaterThan(0);
  },
  120_000,
);
