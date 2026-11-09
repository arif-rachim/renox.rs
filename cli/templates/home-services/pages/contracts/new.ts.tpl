// GET /contracts/new: the contract form. POST ?/create (`contract.write`)
// stores a draft in the active branch (with up to four items; more are added on
// the contract's page) and redirects to it. An invalid form is a 422 naming each
// field (lib/problems.ts); a customer, site or service of another branch is a
// 422 with the reason.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { contractSchema, ITEM_SLOTS } from "../../lib/contract-forms";
import { addDays, yearEnd } from "../../lib/contract-dates";
import { createContract, today } from "../../lib/contracts";
import { check } from "../../lib/forms";
import { shell } from "../../lib/page";
import { unprocessable } from "../../lib/problems";
import { catalogueOf } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "contract.write" };

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
  const names = new Map(customers.map((c) => [c.id, c.name]));
  const start = addDays(today(), 7);
  return {
    ...page,
    customers: customers.map((c) => ({ id: c.id, name: c.name })),
    sites: sites.map((s) => ({ id: s.id, name: `${names.get(s.customer_id) ?? ""} · ${s.label}` })).sort((a, b) => a.name.localeCompare(b.name)),
    catalogue: catalogue.map((s) => ({ sid: String(s.id), name: page.locale === "ar" ? s.name_ar : s.name_en })),
    starts_on: start,
    ends_on: yearEnd(start),
    slots: Array.from({ length: ITEM_SLOTS }, (_, i) => ({ n: i, label: i + 1 })),
  };
}

export const actions = {
  async create(ctx: ActionContext) {
    const page = await shell(ctx);
    const input = await check(ctx.form, contractSchema);
    if ("errors" in input) return unprocessable(page.locale, input.errors, "/contracts/new");
    const made = await createContract(ctx, input.value);
    if (!made.ok) return plain(made.status, made.message);
    return new Response(null, { status: 303, headers: { location: `/contracts/${made.value.id}`, "cache-control": "no-store" } });
  },
};
