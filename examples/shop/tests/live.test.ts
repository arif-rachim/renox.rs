// The live orders screen (#292): a checkout in Acme reaches the SSE client
// of Acme and not the one of another organisation; a subscribe to another
// organisation's topic is not possible (the topic comes from the principal,
// and the policy allows only `orders:<principal.org>`).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app as harness, type TestApp } from "renox/test";

const worker = process.env.RENOX_WORKER_PATH;
const t = worker ? await harness({ project: join(import.meta.dir, "..") }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";

async function member(jar: string, org: string): Promise<TestApp> {
  const u = t.as(jar);
  await u.action("/auth/register", "default", { email: `${jar}@example.com`, password: PASSWORD, display_name: jar });
  expect((await u.action("/auth/login", "default", { email: `${jar}@example.com`, password: PASSWORD })).status).toBe(303);
  expect((await u.action("/org", "create", { name: org, slug: "" })).status).toBe(303);
  return u;
}

async function until(s: Awaited<ReturnType<TestApp["sse"]>>, event: string, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) return null;
    const e = await s.next(left);
    if (e === null || e.event === event) return e;
  }
}

describe.skipIf(!worker)("live orders", () => {
  test("a checkout reaches its organisation's screen only", async () => {
    const amal = await member("amal", "Acme");
    const omar = await member("omar", "Other Co");
    let live = await amal.page("/orders/live");
    for (let i = 0; i < 40 && live.status !== 200; i++) {
      await Bun.sleep(50);
      live = await amal.page("/orders/live");
    }
    expect(live.status).toBe(200);
    for (let i = 0; i < 40 && (await omar.page("/orders/live")).status !== 200; i++) await Bun.sleep(50);
    expect(live.html).toContain('sse-connect="/sse/orders"');
    const a = await amal.sse("/sse/orders");
    const o = await omar.sse("/sse/orders");
    expect(a.status).toBe(200);
    expect(o.status).toBe(200);
    expect((await amal.request("POST", "/api/cart", { body: { cart_id: "c_live", product_id: 7, quantity: 1 } })).status).toBe(201);
    const order = await amal.request("POST", "/api/checkout", { body: { cart_id: "c_live" } });
    expect(order.status).toBe(200);
    const id = order.json<{ order_id: number }>().order_id;
    const e = await until(a, "order-created");
    expect(e?.data).toContain(`id="order-${id}"`);
    expect(await o.next(700)).toBeNull();
    // A signed-out connection: no organisation, the stream ends at once.
    const anon = await t.as("anon").sse("/sse/orders");
    expect(await anon.next(500)).toBeNull();
    a.close();
    o.close();
    anon.close();
  });
});
