// The tax_gcc module in an app with billing, on the real worker (#331): a
// billing invoice issued by the PSP becomes one tax invoice (a redelivery
// adds none), the tax pages need tax.manage, the invoice template carries
// both languages, and its PDF comes out of ctx.pdf.
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
  const sig = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  return t.request("POST", "/billing/webhooks/stripe", { body, headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${sig}` } });
}

async function until<T>(f: () => T[], n = 1): Promise<T[]> {
  for (let i = 0; i < 60; i++) {
    const r = f();
    if (r.length >= n) return r;
    await Bun.sleep(50);
  }
  return f();
}

describe.skipIf(!worker)("tax_gcc in an app", () => {
  test("billing.invoice_issued stamps one tax invoice; a redelivered event adds none", async () => {
    await user("sara");
    const id = t.db.query<{ id: string }>("select id from auth__users where email = 'sara@example.com'")[0]?.id as string;
    const issued = (n: number) => ({ id: `evt_issued_${n}`, type: "invoice.finalized", data: { object: { id: "in_42", customer: "cus_1", amount_due: 29900, currency: "aed", metadata: { customer_id: id } } } });
    expect((await hook(issued(1))).status).toBe(200);
    const docs = await until(() => t.db.query<{ number: string; vat: number }>("select number, vat from tax_gcc__documents"));
    expect(docs).toEqual([{ number: "INV-000001", vat: 1495 }]);
    // The PSP sends the same invoice again under a new event id.
    expect((await hook(issued(2))).status).toBe(200);
    await Bun.sleep(300);
    expect(t.db.query("select number from tax_gcc__documents")).toHaveLength(1);
  });

  test("the pages need tax.manage; the invoice is bilingual; the PDF comes out of ctx.pdf", async () => {
    expect((await (await user("omar")).page("/tax")).status).toBe(403);
    const fin = await user("farah", "finance");
    const r = await fin.page("/tax?from=2000-01-01&to=2100-01-01");
    expect(r.status).toBe(200);
    expect(r.html).toContain("INV-000001");
    const inv = await fin.page("/tax/invoices/INV-000001");
    expect(inv.status).toBe(200);
    for (const s of ["Tax Invoice", "فاتورة ضريبية", "100123456700003", "sara", "313.95"]) expect(inv.html).toContain(s);
    const pdf = await fin.action("/tax/invoices/INV-000001", "pdf", {});
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.html.startsWith("%PDF-")).toBe(true);
    const csv = await fin.action("/tax", "csv", { from: "2000-01-01", to: "2100-01-01" });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.html).toContain("1,Standard rated supplies,299.00,14.95");
  });
});
