// The reports module in an app with billing, tax_gcc and email, on the real
// worker (#333): a PSP's invoice becomes a tax invoice and a payment, the
// page shows the day's sales and cash to reports.view only, the Excel
// export opens in the reader, and the nightly report is kept and emailed.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";
const SECRET = "whsec_billing_test_0123456789abcdef";

async function user(name: string, role?: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  if (role) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}

function hook(event: unknown) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  return t.request("POST", "/billing/webhooks/stripe", { body, headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")}` } });
}

async function until(f: () => boolean) {
  for (let i = 0; i < 60 && !f(); i++) await Bun.sleep(50);
}

const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!worker)("reports in an app", () => {
  test("a PSP invoice issued and paid shows as the day's sales and cash; the page needs reports.view", async () => {
    await user("sara");
    const id = t.db.query<{ id: string }>("select id from auth__users where email = 'sara@example.com'")[0]?.id as string;
    const obj = { id: "in_7", customer: "cus_7", currency: "aed", metadata: { customer_id: id } };
    expect((await hook({ id: "evt_i1", type: "invoice.finalized", data: { object: { ...obj, amount_due: 29900 } } })).status).toBe(200);
    expect((await hook({ id: "evt_p1", type: "invoice.paid", data: { object: { ...obj, amount_paid: 31395 } } })).status).toBe(200);
    await until(() => t.db.query("select 1 from reports__cash").length > 0 && t.db.query("select 1 from tax_gcc__documents").length > 0);
    expect((await (await user("omar")).page("/reports")).status).toBe(403);
    const fin = await user("farah", "finance");
    const r = await fin.page("/reports");
    expect(r.status).toBe(200);
    const html = r.html.replaceAll(' dir="auto"', "");
    expect(html).toContain(`<td>${today}</td><td>1</td><td>299.00</td><td>14.95</td><td>313.95</td>`);
    expect(html).toContain(`<td>${today}</td><td>313.95</td><td>0.00</td><td>313.95</td>`);
  });

  test("the Excel export opens in the reader; the nightly report is kept and emailed", async () => {
    const fin = t.as("farah");
    const page = await fin.page("/reports");
    const csrf = /name="_csrf" value="([^"]+)"/u.exec(page.html)?.[1] as string;
    const form = new URLSearchParams({ _csrf: csrf, kind: "sales", format: "xlsx", from: "2000-01-01", to: "2100-01-01" });
    const xl = await fin.request("POST", "/reports?/export", { body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(xl.status).toBe(200);
    expect(xl.headers.get("content-type")).toContain("spreadsheetml");
    // A zip package (the reader opens the writer's output in tests/xlsx-cash.test.ts).
    expect(xl.html.startsWith("PK")).toBe(true);
    const n = await t.service("reports").nightly(Date.now() + 86_400_000);
    expect(n).toMatchObject({ day: today, sent_to: "owner@example.com" });
    expect(t.db.query<{ day: string }>("select day from reports__snapshots")).toEqual([{ day: today }]);
    expect(t.db.query<{ subject: string }>("select subject from email__messages where to_address = 'owner@example.com'")).toEqual([{ subject: `Daily report ${today}` }]);
  });
});
