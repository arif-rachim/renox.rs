// GET /quotes/:id: one quotation of the active branch (status, lines, totals,
// the PDF links). POST ?/send (`quote.write`) moves a draft to `sent` and issues
// the customer's approval link, shown once on the page that answers (only its
// hash is stored); on a quotation that is already `sent` it issues a new link.
// A quotation of another branch is a 404: the branch-scoped database does not find it.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { issueLink } from "../../lib/links";
import { aed } from "../../lib/money";
import { notifyCustomer } from "../../lib/notify";
import { shell } from "../../lib/page";
import { day, expireDue, findQuote, linesOf, lineView, markSent } from "../../lib/quotes";
import { findCustomer } from "../../lib/customers";
import { branchOf, noBranch, scopedDb, type Branch } from "../../lib/scope";

export const guard = { action: "quote.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function view(ctx: LoaderContext | ActionContext, branch: Branch, locale: string, link: string | null) {
  const scoped = scopedDb(ctx.db, branch);
  await expireDue(scoped);
  const quote = await findQuote(scoped, ctx.params.id);
  if (quote === null) return null;
  const customer = await findCustomer(scoped, quote.customer_id);
  const site = await scoped.queryOne<{ label: string; area: string; address: string }>("select label, area, address from app__sites where id = ?", [quote.site_id]);
  const lines = await linesOf(scoped, quote.id);
  return {
    quote: {
      id: quote.id,
      number: quote.number,
      status: quote.status,
      notes: quote.notes,
      valid_until: day(quote.valid_until),
      created_at: day(quote.created_at),
      approved_at: quote.approved_at === null ? null : day(quote.approved_at),
      approved_ip: quote.approved_ip,
      subtotal: quote.subtotal_fils / 100,
      vat: quote.vat_fils / 100,
      total: quote.total_fils / 100,
    },
    customer: customer === null ? null : { id: customer.id, name: customer.name, phone: customer.phone, language: customer.language },
    site,
    lines: lineView(lines, locale),
    can_send: quote.status === "draft" || quote.status === "sent",
    is_draft: quote.status === "draft",
    link,
    total_text: aed(quote.total_fils),
  };
}

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const data = await view(ctx, branch, page.locale, null);
  if (data === null) return plain(404, "Quotation not found");
  return { ...page, ...data };
}

export const actions = {
  async send(ctx: ActionContext) {
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    try {
      await ctx.authz.require("quote.write");
    } catch (e) {
      if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return plain(403, "Forbidden");
      throw e;
    }
    const scoped = scopedDb(ctx.db, branch);
    await expireDue(scoped);
    const quote = await findQuote(scoped, ctx.params.id);
    if (quote === null) return plain(404, "Quotation not found");
    if (quote.status !== "draft" && quote.status !== "sent") return plain(409, "Only a draft or a sent quotation can be sent.");
    const customer = await findCustomer(scoped, quote.customer_id);
    if (customer === null) return plain(404, "Customer not found");
    if (quote.status === "draft" && !(await markSent(scoped, quote.id))) return plain(409, "The quotation is no longer a draft.");
    const ttl = Math.max(60, quote.valid_until - Math.floor(Date.now() / 1000));
    const path = await issueLink(ctx, "approve", quote.id, ttl);
    await notifyCustomer(ctx, customer, "quote_sent", {
      branch_id: branch.id,
      ref_id: quote.id,
      staff_user: ctx.principal?.id ?? quote.created_by,
      title: `Quotation ${quote.number} for ${customer.name} is ready to send`,
      link: `/quotes/${quote.id}`,
      customer_link: path,
      vars: { number: quote.number },
    });
    const data = await view(ctx, branch, page.locale, `${ctx.url.origin}${path}`);
    return { ...page, ...(data as NonNullable<typeof data>) };
  },
};
