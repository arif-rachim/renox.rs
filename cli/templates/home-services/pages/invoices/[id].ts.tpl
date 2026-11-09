// GET /invoices/:id: one tax invoice of the active branch: the module's document
// (lines, 5 % VAT, totals), its payments and its status. `invoice.read`; an
// invoice of another branch is a 404.
//   POST ?/pay     `invoice.pay` (sensitive: a recent second factor): a cash,
//                  transfer or cheque payment; more than is outstanding is a 422.
//   POST ?/credit  `invoice.issue` (sensitive): a credit note for the whole
//                  invoice; the job is cancelled, the invoice `credited`.
//   POST ?/link    `invoice.issue`: a fresh link for the customer, shown once.
// A refusal of the policy is a 403 that commits, so the platform's audit row of
// the decision stays.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";
import { twofa } from "renox:modules";

import { findCustomer } from "../../lib/customers";
import { check } from "../../lib/forms";
import { creditSchema, METHODS, paymentSchema } from "../../lib/invoice-forms";
import { documentView, invoiceView, paymentView } from "../../lib/invoice-view";
import { creditInvoice, documentOf, findInvoice, INVOICE_LINK_SECONDS, paymentsOf, recordPayment } from "../../lib/invoices";
import { issueLink } from "../../lib/links";
import { shell } from "../../lib/page";
import { invalid } from "../../lib/invalid";
import { day } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb, type Branch } from "../../lib/scope";

export const guard = { action: "invoice.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

async function view(ctx: LoaderContext | ActionContext, branch: Branch, locale: string, link: string | null) {
  const sdb = scopedDb(ctx.db, branch);
  const invoice = await findInvoice(sdb, branch.id, ctx.params.id);
  if (invoice === null) return null;
  const doc = await documentOf(invoice.invoice_id);
  if (doc === null) return null;
  const customer = await findCustomer(sdb, invoice.customer_id);
  // An invoice is a job's, or a maintenance contract's upfront invoice (no job).
  const job = invoice.job_id === null ? null : await sdb.queryOne<{ number: string }>("select number from app__jobs where id = ?", [invoice.job_id]);
  const contract = await sdb.queryOne<{ id: string; number: string }>("select c.id, c.number from app__job_invoices i join app__contracts c on c.id = i.contract_id where i.invoice_id = ?", [invoice.invoice_id]);
  const open = invoice.status === "issued" || invoice.status === "part-paid";
  const canPay = open && (await ctx.authz.can("invoice.pay"));
  const canIssue = invoice.status !== "credited" && (await ctx.authz.can("invoice.issue"));
  const lang = customer?.language === "ar" ? "ar" : "en";
  return {
    invoice: { ...invoiceView(invoice), job_number: job?.number ?? contract?.number ?? "", origin: contract === null ? "job" : "contract", origin_href: contract === null ? `/jobs/${invoice.job_id}` : `/contracts/${contract.id}` },
    customer: customer === null ? null : { id: customer.id, name: customer.name, language: customer.language },
    document: documentView(doc, locale === "ar" ? "ar" : "en"),
    payments: (await paymentsOf(sdb, invoice.invoice_id)).map(paymentView),
    can_pay: canPay,
    can_credit: canIssue,
    can_link: canIssue,
    methods: METHODS.map((m) => ({ value: m })),
    today: day(Math.floor(Date.now() / 1000)),
    values: {},
    pdf_lang: lang,
    link,
  };
}

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const data = await view(ctx, branch, page.locale, null);
  return data === null ? plain(404, "Invoice not found") : { ...page, ...data };
}

/** The 403 of a refused policy decision, or null when allowed (then the second factor is asked for, which throws its own 403 step-up). */
async function sensitive(ctx: ActionContext, action: "invoice.pay" | "invoice.issue"): Promise<Response | null> {
  try {
    await ctx.authz.require(action);
  } catch (e) {
    if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return plain(403, "Forbidden");
    throw e;
  }
  await twofa.requireRecent({ next: `/invoices/${ctx.params.id}` });
  return null;
}

export const actions = {
  async pay(ctx: ActionContext) {
    const page = await shell(ctx);
    const refused = await sensitive(ctx, "invoice.pay");
    if (refused !== null) return refused;
    const back = `/invoices/${ctx.params.id}`;
    const input = await check(ctx.form, paymentSchema(day(Math.floor(Date.now() / 1000))));
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
    const r = await recordPayment(ctx, ctx.params.id, input.value);
    if (r.ok) return redirect(back);
    return r.status === 422 ? invalid(page.locale, ctx.form, { amount: "invoices.err.overpay" }) : plain(r.status, r.message);
  },

  async credit(ctx: ActionContext) {
    const page = await shell(ctx);
    const refused = await sensitive(ctx, "invoice.issue");
    if (refused !== null) return refused;
    const back = `/invoices/${ctx.params.id}`;
    const input = await check(ctx.form, creditSchema);
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
    const r = await creditInvoice(ctx, ctx.params.id, input.value.reason);
    return r.ok ? redirect(back) : plain(r.status, r.message);
  },

  async link(ctx: ActionContext) {
    const page = await shell(ctx);
    const refused = await sensitive(ctx, "invoice.issue");
    if (refused !== null) return refused;
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const invoice = await findInvoice(scopedDb(ctx.db, branch), branch.id, ctx.params.id);
    if (invoice === null) return plain(404, "Invoice not found");
    const path = await issueLink(ctx, "invoice", invoice.invoice_id, INVOICE_LINK_SECONDS);
    const data = await view(ctx, branch, page.locale, `${ctx.url.origin}${path}`);
    return { ...page, ...(data as NonNullable<typeof data>) };
  },
};
