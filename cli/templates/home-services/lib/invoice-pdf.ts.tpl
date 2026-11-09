// The PDFs of invoicing: the tax invoice (the module's document in the app's
// template, partials/pdf/tax-invoice.<lang>.html) and the customer's statement
// (partials/pdf/statement.<lang>.html). Both take the branch-scoped reads their
// caller already did; nothing here asks who the caller is.
import type { DbStatements, Pdf } from "@renoxium/sdk";

import { brandOf, documentView, type Language } from "./invoice-view";
import { type InvoiceRow, type TaxDocument, documentOf, paymentsOf } from "./invoices";
import { aed } from "./money";
import { day } from "./quotes";

interface PdfCtx {
  readonly db: DbStatements;
  readonly pdf: Pick<Pdf, "render">;
}

/** The tax invoice as a PDF in `language`; null when the module has no such document. */
export async function invoicePdf(ctx: PdfCtx, invoice: InvoiceRow, language: Language): Promise<Uint8Array | null> {
  const doc: TaxDocument | null = await documentOf(invoice.invoice_id);
  if (doc === null) return null;
  const data = { ...documentView(doc, language), credit_note: invoice.credit_note_id, brand: await brandOf(ctx.db, language) };
  return ctx.pdf.render(`partials/pdf/tax-invoice.${language}`, data, { page: "A4" });
}

const STATUS_TEXT: Record<string, Record<Language, string>> = {
  issued: { en: "Issued", ar: "صادرة" },
  "part-paid": { en: "Part paid", ar: "مدفوعة جزئياً" },
  paid: { en: "Paid", ar: "مدفوعة" },
  credited: { en: "Credited", ar: "مُلغاة بإشعار دائن" },
};
const METHOD_TEXT: Record<string, Record<Language, string>> = {
  cash: { en: "Cash", ar: "نقداً" },
  transfer: { en: "Bank transfer", ar: "تحويل بنكي" },
  cheque: { en: "Cheque", ar: "شيك" },
};

/**
 * What the statement's template is given: the customer's invoices (open and
 * paid; a credited one is listed with no balance) and every payment against
 * them, in AED. `sdb` is the customer's branch's Db.
 */
export async function statementData(ctx: PdfCtx, sdb: DbStatements, branchId: string, customer: { id: string; name: string; trn: string | null; phone: string }, language: Language) {
  const invoices = await sdb.query<InvoiceRow>(
    "select invoice_id, job_id, branch_id, customer_id, total_fils, due_at, credit_note_id, created_at, paid_fils, status from app__invoice_status where branch_id = ? and customer_id = ? order by created_at, invoice_id",
    [branchId, customer.id],
  );
  const payments = [];
  for (const i of invoices) for (const p of await paymentsOf(sdb, i.invoice_id)) payments.push({ date: day(p.received_at), invoice: i.invoice_id, method: METHOD_TEXT[p.method]?.[language] ?? p.method, amount: p.amount_fils / 100, reference: p.reference, at: p.received_at });
  payments.sort((a, b) => a.at - b.at);
  const balance = (i: InvoiceRow): number => (i.status === "credited" ? 0 : i.total_fils - i.paid_fils);
  const t = Math.floor(Date.now() / 1000);
  return {
    customer: { name: customer.name, trn: customer.trn, phone: customer.phone },
    date: day(t),
    invoices: invoices.map((i) => ({ number: i.invoice_id, date: day(i.created_at), due: day(i.due_at), total: i.total_fils / 100, paid: i.paid_fils / 100, balance: balance(i) / 100, status: STATUS_TEXT[i.status]?.[language] ?? i.status, overdue: (i.status === "issued" || i.status === "part-paid") && i.due_at < t })),
    has_invoices: invoices.length > 0,
    payments: payments.map(({ at: _at, ...p }) => p),
    has_payments: payments.length > 0,
    totals: { invoiced: invoices.filter((i) => i.status !== "credited").reduce((n, i) => n + i.total_fils, 0) / 100, paid: invoices.reduce((n, i) => n + i.paid_fils, 0) / 100, balance: invoices.reduce((n, i) => n + balance(i), 0) / 100 },
    balance_text: aed(invoices.reduce((n, i) => n + balance(i), 0)),
    brand: await brandOf(ctx.db, language),
  };
}

export async function statementPdf(ctx: PdfCtx, sdb: DbStatements, branchId: string, customer: { id: string; name: string; trn: string | null; phone: string }, language: Language): Promise<Uint8Array> {
  return ctx.pdf.render(`partials/pdf/statement.${language}`, await statementData(ctx, sdb, branchId, customer, language), { page: "A4" });
}
