// GET /jobs/new: the job form, blank or from an approved quotation
// (`?quote=<id>`: the site, the first catalogue service and the notes are
// filled in). POST ?/create (`job.write`) stores a `new` job in the
// dispatcher's branch and redirects to it. An invalid form is a 422 naming each
// field (lib/invalid.ts); a refusal of the rules (a quotation that is not
// approved, or already has its job) is a 409 or 422 with the reason.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { newJobSchema } from "../../lib/job-forms";
import { check } from "../../lib/forms";
import { createJob, PRIORITIES } from "../../lib/jobs";
import { shell } from "../../lib/page";
import { invalid } from "../../lib/invalid";
import { catalogueOf } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "job.write" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const scoped = scopedDb(ctx.db, branch);
  const [sites, customers, catalogue] = await Promise.all([
    scoped.query<{ id: string; label: string; customer_id: string }>("select id, label, customer_id from app__sites order by label, id", []),
    scoped.query<{ id: string; name: string }>("select id, name from app__customers order by name, id", []),
    catalogueOf(ctx.db, branch.id),
  ]);
  // From a quotation: only an approved one of this branch (the fence finds no other).
  const asked = ctx.url.searchParams.get("quote") ?? "";
  const quote = /^[A-Za-z0-9_-]{1,64}$/u.test(asked)
    ? await scoped.queryOne<{ id: string; number: string; site_id: string; notes: string; status: string }>("select id, number, site_id, notes, status from app__quotes where id = ?", [asked])
    : null;
  const approved = quote !== null && quote.status === "approved" ? quote : null;
  const line = approved === null ? null : await scoped.queryOne<{ service_id: number | null }>("select service_id from app__quote_lines where quote_id = ? and service_id is not null order by id limit 1", [approved.id]);
  const names = new Map(customers.map((c) => [c.id, c.name]));
  return {
    ...page,
    quote: approved === null ? null : { id: approved.id, number: approved.number },
    sites: sites
      .map((s) => ({ id: s.id, name: `${names.get(s.customer_id) ?? ""} · ${s.label}`, selected: approved !== null && s.id === approved.site_id }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    catalogue: catalogue.map((s) => ({ sid: String(s.id), name: page.locale === "ar" ? s.name_ar : s.name_en, selected: line !== null && line.service_id === s.id })),
    priorities: PRIORITIES.map((p) => ({ value: p, current: p === "normal" })),
    values: {},
    description: approved === null ? "" : `${approved.number}${approved.notes === "" ? "" : `: ${approved.notes}`}`.slice(0, 1000),
  };
}

export const actions = {
  async create(ctx: ActionContext) {
    const page = await shell(ctx);
    const input = await check(ctx.form, newJobSchema);
    if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
    const made = await createJob(ctx, input.value);
    if (!made.ok) return plain(made.status, made.message);
    return new Response(null, { status: 303, headers: { location: `/jobs/${made.job.id}`, "cache-control": "no-store" } });
  },
};
