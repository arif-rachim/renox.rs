// #325: a period closed into an AED tax invoice: plan line, VAT 5 % half up,
// sequential numbers, both TRNs, the bilingual HTML for the PDF.
import { expect, test } from "bun:test";

import { aed, closePeriod, fils, invoiceHtml, planOf, PLANS, vatOf } from "../src/index.ts";
import spec from "../../../docs/contracts/schemas/deploy-api.yaml";

test("amounts in fils and VAT half up", () => {
  expect(fils("79.00")).toBe(7900);
  expect(aed(8295)).toBe("82.95");
  expect(vatOf(7900)).toBe(395);
  expect(vatOf(10)).toBe(1); // 0.5 fils rounds up
  expect(vatOf(9)).toBe(0);
});

test("closing a Starter month: one line, 5 % VAT, both TRNs, the number", () => {
  const inv = closePeriod({
    tenantId: "t_hello",
    plan: planOf("starter")!,
    period: { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 10, 1) },
    sequence: 123,
    sellerTrn: "100987654300003",
    buyerTrn: "100123456700003",
    now: Date.UTC(2026, 10, 1),
    monthLabel: "October 2026",
  })!;
  expect(inv).toMatchObject({ id: "INV-2026-000123", subtotal: "79.00", vat: "3.95", total: "82.95", currency: "AED", seller_trn: "100987654300003", buyer_trn: "100123456700003", status: "open" });
  expect(inv.lines).toEqual([{ description: "Starter plan, October 2026", quantity: "1", unit_price: "79.00", amount: "79.00" }]);
  const html = invoiceHtml(inv, { legal_name: "Hello <Trading> LLC", address: "Dubai" });
  for (const s of ["Tax Invoice", "فاتورة ضريبية", "INV-2026-000123", "TRN 100987654300003", "TRN 100123456700003", "82.95", "Hello &lt;Trading&gt; LLC"]) expect(html).toContain(s);
  // A free plan with nothing else has no invoice.
  expect(closePeriod({ tenantId: "t", plan: planOf("free")!, period: inv.period, sequence: 1, sellerTrn: "1", buyerTrn: null, now: 0, monthLabel: "x" })).toBeNull();
});

test("the plans are the contract's listPlans example", () => {
  const ex = (spec as any).components.examples.Plans.value;
  expect(PLANS.map((p) => ({ id: p.id, name: p.name, price_month: p.price_month, quotas: p.quotas }))).toEqual(ex.plans);
});
