// Monthly invoices (#325; deploy-api.md 0.5 section 20): AED in fils
// (integers), 5 % VAT rounded half up to fils, numbering without gaps per
// year (`INV-<year>-<6 digits>`, UAE FTA: sequential tax invoice numbers),
// Renox's TRN and the tenant's when given.

import { type Plan, VAT_RATE } from "./plans.ts";

export interface InvoiceLine {
  description: string;
  quantity: string;
  unit_price: string;
  amount: string;
}

export interface Invoice {
  id: string;
  tenant_id: string;
  period: { start: number; end: number };
  status: "open" | "paid" | "failed" | "void";
  lines: InvoiceLine[];
  subtotal: string;
  vat: string;
  total: string;
  currency: "AED";
  seller_trn: string;
  buyer_trn: string | null;
  issued_at: number;
  paid_at: number | null;
}

/** AED decimal string -> fils. */
export function fils(aed: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(aed);
  if (m === null) throw new Error(`not an AED amount: ${aed}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export const aed = (f: number): string => `${Math.floor(f / 100)}.${String(f % 100).padStart(2, "0")}`;

/** VAT in fils, half up (5 % of 3.95 fils-exact amounts is exact; 0.5 fils rounds up). */
export function vatOf(subtotalFils: number): number {
  const [num, den] = [Math.round(Number(VAT_RATE) * 10_000), 10_000];
  return Math.floor((subtotalFils * num * 2 + den) / (2 * den));
}

export const invoiceNumber = (year: number, sequence: number): string => `INV-${year}-${String(sequence).padStart(6, "0")}`;

export interface CloseInput {
  tenantId: string;
  plan: Plan;
  period: { start: number; end: number };
  /** Lines beyond the plan (prorated upgrades, overage), in fils. */
  extra?: { description: string; fils: number }[];
  sequence: number;
  sellerTrn: string;
  buyerTrn: string | null;
  now: number;
  monthLabel: string;
}

/** The invoice of one closed period; `null` for a free plan with nothing else to bill. */
export function closePeriod(i: CloseInput): Invoice | null {
  const lines: InvoiceLine[] = [];
  const planFils = fils(i.plan.price_month);
  if (planFils > 0) lines.push({ description: `${i.plan.name} plan, ${i.monthLabel}`, quantity: "1", unit_price: aed(planFils), amount: aed(planFils) });
  for (const x of i.extra ?? []) if (x.fils > 0) lines.push({ description: x.description, quantity: "1", unit_price: aed(x.fils), amount: aed(x.fils) });
  if (lines.length === 0) return null;
  const subtotal = lines.reduce((s, l) => s + fils(l.amount), 0);
  const vat = vatOf(subtotal);
  return {
    id: invoiceNumber(new Date(i.period.end - 1).getUTCFullYear(), i.sequence),
    tenant_id: i.tenantId,
    period: i.period,
    status: "open",
    lines,
    subtotal: aed(subtotal),
    vat: aed(vat),
    total: aed(subtotal + vat),
    currency: "AED",
    seller_trn: i.sellerTrn,
    buyer_trn: i.buyerTrn,
    issued_at: i.now,
    paid_at: null,
  };
}

/** The bilingual tax invoice as HTML, for `ctx.pdf` / the dashboard's render route. */
export function invoiceHtml(inv: Invoice, buyer: { legal_name: string; address: string }): string {
  const esc = (s: string) => s.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  const rows = inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${l.quantity}</td><td>${l.amount}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><body>
<h1>Tax Invoice</h1><div dir="rtl" lang="ar"><h2>فاتورة ضريبية</h2></div>
<p>${inv.id}</p><p>Renox — TRN ${inv.seller_trn}</p>
<p>${esc(buyer.legal_name)}${inv.buyer_trn ? ` — TRN ${inv.buyer_trn}` : ""}</p><p>${esc(buyer.address)}</p>
<table><tr><th>Item</th><th>Qty</th><th>Amount (AED)</th></tr>${rows}
<tr><td>VAT 5 %</td><td></td><td>${inv.vat}</td></tr><tr><td><strong>Total</strong></td><td></td><td><strong>${inv.total}</strong></td></tr></table>
</body></html>`;
}
