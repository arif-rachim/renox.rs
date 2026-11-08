// GET /l/approve/:token: the customer's view of one quotation, with an Approve
// and a Reject form. Public on purpose: no `guard`, no sign-in; the token is the
// only credential (lib/links.ts: random, stored hashed, expiring, single use).
// The page reads nothing but the quotation the token names, by its id, and
// never another table of the branch except that quotation's lines, customer
// and branch name. POST ?/approve and ?/reject answer once: the link is
// consumed, the quotation moves to `approved` / `rejected` with the time and
// the address, and the dispatcher who created it is notified. A tampered token
// is a 404, a used one a 409 page, an expired one a 410 page.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { consumeLink, verifyLink } from "../../../lib/links";
import { notifyCustomer } from "../../../lib/notify";
import { shell } from "../../../lib/page";
import { day, decide, expireDue, findQuote, linesOf, lineView, type QuoteRow } from "../../../lib/quotes";
import { fencedTo } from "../../../lib/scope";

const MESSAGES = {
  used: { en: "This quotation was already answered.", ar: "تمت الإجابة على عرض السعر هذا مسبقاً." },
  expired: { en: "This link has expired. Please ask us for a new quotation.", ar: "انتهت صلاحية هذا الرابط. يرجى طلب عرض سعر جديد." },
  gone: { en: "This quotation can no longer be answered.", ar: "لم يعد بالإمكان الرد على عرض السعر هذا." },
} as const;

/** A small bilingual page for a refused answer; the link's own page is not rendered for it. */
function refusal(status: number, kind: keyof typeof MESSAGES): Response {
  const m = MESSAGES[kind];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${m.en}</title><link rel="stylesheet" href="/renox-ui.css"><link rel="stylesheet" href="/app.css"></head><body><main><p id="refusal-${kind}">${m.en}</p><p dir="rtl" lang="ar">${m.ar}</p></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const notFound = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** What the page shows: `open` (answerable), or the quotation's own end state. */
function stateOf(quote: QuoteRow, link: "ok" | "expired" | "used"): "open" | "approved" | "rejected" | "expired" {
  if (quote.status === "approved" || quote.status === "rejected") return quote.status;
  if (quote.status === "expired" || link === "expired") return "expired";
  return "open";
}

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const link = await verifyLink(ctx, "approve", ctx.params.token);
  if (link.state === "invalid") return notFound();
  // The token names one quotation; from here every statement is fenced to its branch.
  const named = await findQuote(ctx.db, link.refId);
  if (named === null) return notFound();
  const sdb = fencedTo(ctx.db, named.branch_id);
  await expireDue(sdb, named.id);
  const quote = (await findQuote(sdb, named.id)) ?? named;
  const customer = await sdb.queryOne<{ name: string }>("select name from app__customers where id = ?", [quote.customer_id]);
  const lines = lineView(await linesOf(sdb, quote.id), page.locale);
  const state = stateOf(quote, link.state);
  return {
    ...page,
    state,
    quote: {
      number: quote.number,
      valid_until: day(quote.valid_until),
      notes: quote.notes,
      subtotal: quote.subtotal_fils / 100,
      vat: quote.vat_fils / 100,
      total: quote.total_fils / 100,
    },
    customer_name: customer?.name ?? "",
    lines,
    is_open: state === "open",
    is_approved: state === "approved",
    is_rejected: state === "rejected",
    is_expired: state === "expired",
  };
}

/** The address the request came from, as the edge reports it (Cloudflare first); null when unknown. */
const clientIp = (headers: Headers): string | null => {
  const cf = headers.get("cf-connecting-ip");
  if (cf !== null && cf !== "") return cf.slice(0, 64);
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff === undefined || xff === "" ? null : xff.slice(0, 64);
};

async function answer(ctx: ActionContext, to: "approved" | "rejected"): Promise<Response> {
  const token = ctx.params.token;
  const link = await verifyLink(ctx, "approve", token);
  if (link.state === "invalid") return notFound();
  if (link.state === "used") return refusal(409, "used");
  if (link.state === "expired") return refusal(410, "expired");
  // One submit wins: the link is consumed before the quotation changes.
  if (!(await consumeLink(ctx, token as string))) return refusal(409, "used");
  const named = await findQuote(ctx.db, link.refId);
  if (named === null) return notFound();
  const sdb = fencedTo(ctx.db, named.branch_id);
  await expireDue(sdb, named.id);
  const quote = (await findQuote(sdb, named.id)) ?? named;
  if (!(await decide(sdb, quote.id, to, clientIp(ctx.headers)))) return refusal(409, quote.status === "expired" ? "expired" : "gone");
  const customer = await sdb.queryOne<{ id: string; name: string }>("select id, name from app__customers where id = ?", [quote.customer_id]);
  if (customer !== null) {
    await notifyCustomer(ctx, customer, to === "approved" ? "quote_approved" : "quote_rejected", {
      branch_id: quote.branch_id,
      ref_id: quote.id,
      staff_user: quote.created_by,
      title: `Quotation ${quote.number} was ${to} by ${customer.name}`,
      link: `/quotes/${quote.id}`,
    });
  }
  return new Response(null, { status: 303, headers: { location: ctx.url.pathname, "cache-control": "no-store" } });
}

export const actions = {
  approve: (ctx: ActionContext) => answer(ctx, "approved"),
  reject: (ctx: ActionContext) => answer(ctx, "rejected"),
};
