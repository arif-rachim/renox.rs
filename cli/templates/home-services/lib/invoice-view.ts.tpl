// What the invoice pages, the customer's page and the PDFs are given: the
// module's document (fils) turned into AED amounts the templates format with
// `money` / `number(2)`, in the language asked for.
import type { DbStatements } from "@renoxium/sdk";

import { type InvoiceRow, type PaymentRow, type TaxDocument, STATUSES } from "./invoices";
import { aed } from "./money";
import { day } from "./quotes";
import { getSettings, pdfBrand } from "./settings";

export type Language = "en" | "ar";

const RATES: Record<string, Record<Language, string>> = {
  standard: { en: "5 %", ar: "5 %" },
  zero: { en: "0 % (zero rated)", ar: "0 % (بنسبة صفر)" },
  exempt: { en: "Exempt", ar: "معفى" },
};

/** The lines and totals of the document in AED, with the VAT rate of each line spelled out. */
export function documentView(doc: TaxDocument, language: Language) {
  return {
    number: doc.number,
    issued: day(Math.floor(doc.issued_at / 1000)),
    seller: doc.seller,
    buyer: doc.buyer,
    lines: doc.lines.map((l) => ({ description: l.description, qty: l.quantity, unit_price: l.unit_fils / 100, net: l.net_fils / 100, vat: l.vat_fils / 100, rate: RATES[l.rate]?.[language] ?? l.rate })),
    totals: { standard: doc.totals.standard / 100, zero: doc.totals.zero / 100, exempt: doc.totals.exempt / 100, vat: doc.totals.vat / 100, total: doc.totals.total / 100 },
    total_text: aed(doc.totals.total),
  };
}

export const paymentView = (p: PaymentRow) => ({
  id: p.id,
  date: day(p.received_at),
  method: p.method,
  amount: p.amount_fils / 100,
  reference: p.reference,
  cheque_number: p.cheque_number,
  cheque_date: p.cheque_date,
});

/** The invoice's state for a page: amounts in AED, `overdue` when issued or part-paid past the due date. */
export function invoiceView(r: InvoiceRow) {
  const overdue = (r.status === "issued" || r.status === "part-paid") && r.due_at < Math.floor(Date.now() / 1000);
  return {
    id: r.invoice_id,
    job_id: r.job_id,
    status: r.status,
    overdue,
    total: r.total_fils / 100,
    paid: r.paid_fils / 100,
    balance: (r.status === "credited" ? 0 : r.total_fils - r.paid_fils) / 100,
    due: day(r.due_at),
    issued: day(r.created_at),
    credit_note: r.credit_note_id,
  };
}

/** The brand block every PDF carries (the colour goes in style attributes: templates do not interpolate inside <style>). */
export async function brandOf(db: DbStatements, language: Language) {
  return pdfBrand(await getSettings(db), language);
}

export const isStatus = (s: string): s is (typeof STATUSES)[number] => (STATUSES as readonly string[]).includes(s);
