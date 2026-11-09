// GET /contracts: the active branch's maintenance contracts, newest first,
// filtered by `?status=draft|active|expired|cancelled`. `contract.read`:
// dispatcher and above (the accountant reads too). Rows come through the
// branch-scoped database.
import type { LoaderContext } from "@renoxium/sdk";

import { listContracts, STATUSES } from "../../lib/contracts";
import { aed } from "../../lib/money";
import { shell } from "../../lib/page";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "contract.read" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const asked = ctx.url.searchParams.get("status") ?? "";
  const status = (STATUSES as readonly string[]).includes(asked) ? asked : "";
  const rows = await listContracts(scopedDb(ctx.db, branch), status);
  return {
    ...page,
    status,
    statuses: STATUSES.map((s) => ({ value: s, current: s === status })),
    can_write: await ctx.authz.can("contract.write"),
    contracts: rows.map((c) => ({ id: c.id, number: c.number, status: c.status, customer_id: c.customer_id, customer_name: c.customer_name, starts_on: c.starts_on, ends_on: c.ends_on, price: c.price_fils / 100, price_text: aed(c.price_fils), items: c.items })),
  };
}
