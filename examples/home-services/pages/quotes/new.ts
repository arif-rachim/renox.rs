// GET /quotes/new: the quotation form (site, validity, notes, up to eight lines
// from the catalogue or in free text) with the AI draft box.
// POST ?/create stores a draft in the dispatcher's branch and redirects to it;
// an invalid form is a 422 naming each field (lib/invalid.ts).
// POST ?/draft asks `ctx.ai` for lines from a free-text request and shows the
// form again with them filled in; without an AI provider it says "AI off" and
// the form works as it does without it.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { draftLines, type DraftState } from "../../lib/draft";
import { check, LINE_SLOTS, quoteSchema, valuesOf } from "../../lib/forms";
import { shell } from "../../lib/page";
import { invalid } from "../../lib/invalid";
import { catalogueOf, insertQuote, resolveLines, type ServiceRow } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb, type Branch } from "../../lib/scope";

export const guard = { action: "quote.write" };

type Values = Record<string, string>;
type Row = { i: number; service: string; desc: string; desc_ar: string; qty: string; price: string };

/** The line rows to show: those the form carried, then `extra` (a draft's) after them, and a blank row to add to (at least four rows). */
function rowsOf(values: Values, extra: readonly { service: string; qty: string }[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < LINE_SLOTS; i++) {
    const row = { i: rows.length, service: values[`service_${i}`] ?? "", desc: values[`desc_${i}`] ?? "", desc_ar: values[`desc_ar_${i}`] ?? "", qty: values[`qty_${i}`] ?? "1", price: values[`price_${i}`] ?? "" };
    if (row.service !== "" || row.desc !== "") rows.push(row);
  }
  for (const e of extra) {
    if (rows.length >= LINE_SLOTS) break;
    rows.push({ i: rows.length, service: e.service, desc: "", desc_ar: "", qty: e.qty, price: "" });
  }
  const want = Math.min(LINE_SLOTS, Math.max(4, rows.length + 1));
  while (rows.length < want) rows.push({ i: rows.length, service: "", desc: "", desc_ar: "", qty: "1", price: "" });
  return rows;
}

async function formData(ctx: LoaderContext | ActionContext, branch: Branch, locale: string, values: Values, draft: { lines: readonly { service_id: number; qty: number }[]; ai: DraftState } | null) {
  const scoped = scopedDb(ctx.db, branch);
  const [sites, customers, catalogue] = await Promise.all([
    scoped.query<{ id: string; label: string; customer_id: string }>("select id, label, customer_id from app__sites order by label, id", []),
    scoped.query<{ id: string; name: string }>("select id, name from app__customers order by name, id", []),
    catalogueOf(ctx.db, branch.id),
  ]);
  const names = new Map(customers.map((c) => [c.id, c.name]));
  const site = values.site_id ?? ctx.url.searchParams.get("site") ?? "";
  return {
    sites: sites.map((s) => ({ id: s.id, name: `${names.get(s.customer_id) ?? ""} · ${s.label}`, selected: s.id === site })).sort((a, b) => a.name.localeCompare(b.name)),
    catalogue: catalogue.map((s: ServiceRow) => ({ sid: String(s.id), name: `${locale === "ar" ? s.name_ar : s.name_en} (${s.code})` })),
    rows: rowsOf(values, (draft?.lines ?? []).map((l) => ({ service: String(l.service_id), qty: String(l.qty) }))),
    v: { valid_days: values.valid_days ?? "30", notes: values.notes ?? "", request: values.request ?? "" },
    ai_state: draft?.ai ?? null,
    drafted: draft === null ? 0 : draft.lines.length,
  };
}

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  return { ...page, ...(await formData(ctx, branch, page.locale, {}, null)) };
}

export const actions = {
  async create(ctx: ActionContext) {
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    // The form again with what was typed, the lines included (422).
    const refuse = async (errors: Record<string, string>) => ({ ...invalid(page.locale, ctx.form, errors), ...(await formData(ctx, branch, page.locale, valuesOf(ctx.form), null)) });
    const input = await check(ctx.form, quoteSchema);
    if ("errors" in input) return refuse(input.errors);
    const scoped = scopedDb(ctx.db, branch);
    // The site must be the branch's (the fence finds no other); the quotation is the site's customer's.
    const site = await scoped.queryOne<{ id: string; customer_id: string }>("select id, customer_id from app__sites where id = ?", [input.value.site_id]);
    if (site === null) return refuse({ site_id: "quotes.err.site" });
    const resolved = resolveLines(input.value.lines, await catalogueOf(ctx.db, branch.id));
    if ("bad" in resolved) return refuse({ [`service_${resolved.bad}`]: "quotes.err.service" });
    const userId = ctx.principal?.id;
    if (userId === undefined) return new Response("Forbidden", { status: 403 });
    const validUntil = Math.floor(Date.now() / 1000) + input.value.valid_days * 86400;
    const id = await insertQuote(ctx.db, scoped, { branch: branch.id, customer: site.customer_id, site: site.id, validUntil, notes: input.value.notes, by: userId, lines: resolved.lines });
    return new Response(null, { status: 303, headers: { location: `/quotes/${id}`, "cache-control": "no-store" } });
  },

  async draft(ctx: ActionContext) {
    const page = await shell(ctx);
    const branch = await branchOf(ctx);
    if (branch === null) return noBranch();
    const values = valuesOf(ctx.form);
    const draft = await draftLines(ctx.ai, await catalogueOf(ctx.db, branch.id), values.request ?? "");
    return { ...page, ...(await formData(ctx, branch, page.locale, values, draft)) };
  },
};
