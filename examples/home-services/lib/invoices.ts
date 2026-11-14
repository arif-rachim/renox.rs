// Invoicing: the tax invoice of a done job, the payments against it, the credit
// note, the list and the statement. The document itself (its number, the lines,
// the 5 % VAT and the buyer's TRN) is the `tax_gcc` module's, issued by its
// `issue` service and immutable; this file keeps the mapping from the job
// (app__job_invoices), the payments (app__payments) and works out the status
// from the view app__invoice_status.
//
// Everything of the branch goes through the branch-scoped Db of lib/scope.ts;
// the view is not ownable, so every statement on it names `branch_id` itself.
// A module service that throws inside the action's transaction rolls it back, so
// the checks that can fail come first: a TaxError after the job moved to
// `invoiced` leaves nothing behind.
import type { DbStatements } from "@renoxium/sdk";
import { audit, tax_gcc } from "renox:modules";

import { findCustomer } from "./customers";
import { type JobCtx, cancelInvoiced, findJob, transition } from "./jobs";
import { issueLink } from "./links";
import { aed } from "./money";
import { type Method, type PaymentInput } from "./invoice-forms";
import { notifyCustomer } from "./notify";
import { day, linesOf } from "./quotes";
import { branchOf, scopedDb } from "./scope";
import { partName, partsOf, visitOfJob } from "./visit-data";

export const STATUSES = ["issued", "part-paid", "paid", "credited"] as const;
export type InvoiceStatus = (typeof STATUSES)[number];

export type InvoiceRow = {
  invoice_id: string;
  /** null for a maintenance contract's upfront invoice (the contract is in app__job_invoices.contract_id). */
  job_id: string | null;
  branch_id: string;
  customer_id: string;
  total_fils: number;
  due_at: number;
  credit_note_id: string | null;
  created_at: number;
  paid_fils: number;
  status: InvoiceStatus;
};

export type PaymentRow = {
  id: number;
  invoice_id: string;
  method: Method;
  amount_fils: number;
  received_at: number;
  reference: string;
  cheque_number: string | null;
  cheque_date: string | null;
  recorded_by: string;
};

const COLUMNS = "invoice_id, job_id, branch_id, customer_id, total_fils, due_at, credit_note_id, created_at, paid_fils, status";
const now = (): number => Math.floor(Date.now() / 1000);

/** Payment terms: an invoice falls due thirty days after it is issued. */
export const TERMS_DAYS = 30;
/** How long the customer's link to the invoice works: 90 days. */
export const INVOICE_LINK_SECONDS = 90 * 24 * 3600;

/** A tax_gcc number from a URL or a form: `INV-000001`; anything else is no invoice. */
export const invoiceId = (raw: unknown): string | null => (typeof raw === "string" && /^INV-\d{6,}$/u.test(raw) ? raw : null);

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 403 | 404 | 409 | 422; message: string };
const fail = (status: 403 | 404 | 409 | 422, message: string): { ok: false; status: 403 | 404 | 409 | 422; message: string } => ({ ok: false, status, message });

/** An invoice of the branch, or null: another branch's is not found. */
export async function findInvoice(sdb: DbStatements, branchId: string, id: unknown): Promise<InvoiceRow | null> {
  const key = invoiceId(id);
  return key === null ? null : sdb.queryOne<InvoiceRow>(`select ${COLUMNS} from app__invoice_status where branch_id = ? and invoice_id = ?`, [branchId, key]);
}

/** The invoice of a job, or null. */
export async function invoiceOfJob(sdb: DbStatements, branchId: string, jobId: string): Promise<InvoiceRow | null> {
  return sdb.queryOne<InvoiceRow>(`select ${COLUMNS} from app__invoice_status where branch_id = ? and job_id = ?`, [branchId, jobId]);
}

/** The branch's invoices, newest first; `overdue` is an issued or part-paid one past its due date. */
export async function listInvoices(sdb: DbStatements, branchId: string, filter: InvoiceStatus | "overdue" | "open" | ""): Promise<(InvoiceRow & { customer_name: string; overdue: boolean })[]> {
  const rows = await sdb.query<InvoiceRow & { customer_name: string }>(
    `select s.invoice_id, s.job_id, s.branch_id, s.customer_id, s.total_fils, s.due_at, s.credit_note_id, s.created_at, s.paid_fils, s.status, c.name as customer_name
     from app__invoice_status s join app__customers c on c.id = s.customer_id where s.branch_id = ? and c.branch_id = ? order by s.created_at desc, s.invoice_id desc limit 300`,
    [branchId, branchId],
  );
  const t = now();
  const all = rows.map((r) => ({ ...r, overdue: (r.status === "issued" || r.status === "part-paid") && r.due_at < t }));
  if (filter === "") return all;
  if (filter === "overdue") return all.filter((r) => r.overdue);
  if (filter === "open") return all.filter((r) => r.status === "issued" || r.status === "part-paid");
  return all.filter((r) => r.status === filter);
}

export async function paymentsOf(sdb: DbStatements, invoice: string): Promise<PaymentRow[]> {
  return sdb.query<PaymentRow>("select id, invoice_id, method, amount_fils, received_at, reference, cheque_number, cheque_date, recorded_by from app__payments where invoice_id = ? order by received_at, id", [invoice]);
}

/** What the document of `tax_gcc` holds, as the app shows and prints it (the module's fils kept). */
export type TaxDocument = {
  kind: "invoice" | "credit_note";
  number: string;
  issued_at: number;
  seller: { name: string; trn: string; address: string };
  buyer: { name: string; trn: string | null; address: string };
  lines: { description: string; quantity: number; unit_fils: number; rate: string; net_fils: number; vat_fils: number }[];
  totals: { standard: number; zero: number; exempt: number; vat: number; total: number };
};

export const documentOf = async (number: string): Promise<TaxDocument | null> => (await tax_gcc.invoice(number)) as TaxDocument | null;

type TaxLine = { description: string; quantity: number; unit_fils: number; rate: "standard" | "zero" };

/**
 * The lines of a job's invoice: the approved quotation's lines when there is
 * one (in the customer's language), else the service at the catalogue price,
 * once; then every part the technician used on the visit.
 */
export async function invoiceLines(sdb: DbStatements, ctx: { db: DbStatements }, job: { id: string; quote_id: string | null; service_id: number }, language: "en" | "ar"): Promise<TaxLine[]> {
  const out: TaxLine[] = [];
  if (job.quote_id !== null) {
    for (const l of await linesOf(sdb, job.quote_id)) out.push({ description: language === "ar" ? l.description_ar : l.description_en, quantity: l.qty, unit_fils: l.unit_price_fils, rate: "standard" });
  } else {
    const s = await ctx.db.queryOne<{ name_en: string; name_ar: string; price_fils: number }>("select name_en, name_ar, price_fils from app__services where id = ?", [job.service_id]);
    if (s !== null) out.push({ description: language === "ar" ? s.name_ar : s.name_en, quantity: 1, unit_fils: s.price_fils, rate: "standard" });
  }
  const visit = await visitOfJob(sdb, job.id);
  if (visit !== null) for (const p of await partsOf(sdb, visit.id)) out.push({ description: partName(p, language), quantity: p.qty, unit_fils: p.unit_price_fils, rate: p.vat_rate === 0 ? "zero" : "standard" });
  return out;
}

export interface Issued {
  number: string;
  /** The customer's link, a path (`/l/invoice/<token>`): shown once, only its hash is kept. */
  link: string;
}

/**
 * Issues the tax invoice of a done job: lines from `invoiceLines`, the
 * customer's name, TRN and the site's address as the buyer, the number and the
 * 5 % VAT from the module. The job becomes `invoiced`, the mapping is kept and
 * the customer gets a link (`invoice_due`). 409 when the job is not done or
 * already has its invoice, 422 when there is nothing to invoice.
 */
export async function issueInvoice(ctx: JobCtx & { readonly url?: URL }, rawJobId: unknown): Promise<Outcome<Issued>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const job = await findJob(sdb, rawJobId);
  if (job === null) return fail(404, "Job not found");
  const existing = await invoiceOfJob(sdb, branch.id, job.id);
  if (existing !== null) return fail(409, `Job ${job.number} already has invoice ${existing.invoice_id}.`);
  if (job.status !== "done") return fail(409, `Only a done job is invoiced; ${job.number} is ${job.status.replace("_", " ")}.`);
  const customer = await findCustomer(sdb, job.customer_id);
  if (customer === null) return fail(404, "Customer not found");
  const site = await sdb.queryOne<{ label: string; area: string; address: string }>("select label, area, address from app__sites where id = ?", [job.site_id]);
  const lines = await invoiceLines(sdb, ctx, job, customer.language);
  if (lines.reduce((n, l) => n + Math.round(l.quantity * l.unit_fils), 0) <= 0) return fail(422, "There is nothing to invoice on this job.");
  // The module throws on a bad line or a missing seller TRN: that rolls the whole action back, so nothing is half issued.
  const doc = (await tax_gcc.issue({ buyer: { name: customer.name, ...(customer.trn === null ? {} : { trn: customer.trn }), address: site === null ? "" : `${site.label}, ${site.area}, ${site.address}` }, lines })) as TaxDocument;
  const moved = await transition(ctx, job.id, "invoiced", `invoice ${doc.number}`);
  if (!moved.ok) throw new Error(`job ${job.number} could not become invoiced after ${doc.number} was issued: ${moved.message}`);
  const t = now();
  await sdb.execute("insert into app__job_invoices (job_id, branch_id, customer_id, invoice_id, total_fils, due_at, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", [
    job.id,
    branch.id,
    customer.id,
    doc.number,
    doc.totals.total,
    t + TERMS_DAYS * 86400,
    ctx.principal?.id ?? "",
    t,
  ]);
  await audit.record({ action: "invoice.issue", actor: { kind: "user", id: ctx.principal?.id ?? "unknown" }, resource: { type: "Invoice", id: doc.number }, details: { job: job.number, total_fils: doc.totals.total } });
  const link = await issueLink(ctx, "invoice", doc.number, INVOICE_LINK_SECONDS);
  await notifyCustomer(ctx, customer, "invoice_due", { branch_id: branch.id, ref_id: doc.number, job_id: job.id, customer_link: link, vars: { number: doc.number, amount: `AED ${aed(doc.totals.total)}` } });
  return { ok: true, value: { number: doc.number, link } };
}

/** Records a payment: 409 for a credited invoice, 422 for more than is outstanding. The audit trail gets the method, the amount and who recorded it. */
export async function recordPayment(ctx: JobCtx, rawInvoice: unknown, input: PaymentInput): Promise<Outcome<PaymentRow>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const invoice = await findInvoice(sdb, branch.id, rawInvoice);
  if (invoice === null) return fail(404, "Invoice not found");
  if (invoice.status === "credited") return fail(409, `Invoice ${invoice.invoice_id} was credited and takes no payment.`);
  const outstanding = invoice.total_fils - invoice.paid_fils;
  if (input.amount_fils > outstanding) return fail(422, `The payment is ${aed(input.amount_fils)}, more than the ${aed(outstanding)} outstanding.`);
  const by = ctx.principal?.id ?? "unknown";
  const receivedAt = Math.floor(Date.parse(`${input.received_on}T00:00:00Z`) / 1000) - 4 * 3600;
  const n = await sdb.execute(
    "insert into app__payments (branch_id, invoice_id, method, amount_fils, received_at, reference, cheque_number, cheque_date, recorded_by, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [branch.id, invoice.invoice_id, input.method, input.amount_fils, receivedAt, input.reference, input.cheque_number, input.cheque_date, by, now()],
  );
  await audit.record({
    action: "invoice.payment",
    actor: { kind: "user", id: by },
    resource: { type: "Invoice", id: invoice.invoice_id },
    details: { method: input.method, amount_fils: input.amount_fils, cheque_number: input.cheque_number, reference: input.reference },
  });
  const row = (await paymentsOf(sdb, invoice.invoice_id)).find((p) => p.id === Number((n as { lastInsertRowid?: number | bigint }).lastInsertRowid));
  return { ok: true, value: row as PaymentRow };
}

/**
 * A credit note for the whole invoice through the module's `creditNote`
 * service, for an invoiced job that is cancelled after it was issued: the job
 * becomes `cancelled` (the job's timeline names the credit note) and the
 * invoice `credited`. Payments already recorded stay on the books: refunding
 * them is the accountant's, outside the app. 409 when it was credited already.
 */
export async function creditInvoice(ctx: JobCtx, rawInvoice: unknown, reason: string): Promise<Outcome<{ credit_note: string }>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const invoice = await findInvoice(sdb, branch.id, rawInvoice);
  if (invoice === null) return fail(404, "Invoice not found");
  if (invoice.status === "credited") return fail(409, `Invoice ${invoice.invoice_id} was credited already (${invoice.credit_note_id}).`);
  const note = (await tax_gcc.creditNote(invoice.invoice_id, undefined, reason)) as TaxDocument;
  await sdb.execute("update app__job_invoices set credit_note_id = ? where invoice_id = ? and credit_note_id is null", [note.number, invoice.invoice_id]);
  const cancelled = await cancelInvoiced(ctx, invoice.job_id, `credit note ${note.number}: ${reason}`);
  if (!cancelled.ok) throw new Error(`job of ${invoice.invoice_id} could not be cancelled after ${note.number}: ${cancelled.message}`);
  await audit.record({ action: "invoice.credit", actor: { kind: "user", id: ctx.principal?.id ?? "unknown" }, resource: { type: "Invoice", id: invoice.invoice_id }, details: { credit_note: note.number, reason } });
  return { ok: true, value: { credit_note: note.number } };
}

export const dueLabel = (r: Pick<InvoiceRow, "due_at">): string => day(r.due_at);
