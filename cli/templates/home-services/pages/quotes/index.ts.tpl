// GET /quotes: the active branch's quotations, newest first, filtered by
// status (`?status=sent`). `quote.read`: dispatcher and above; a technician
// gets 403 from the guard. Rows come through the branch-scoped database.
import type { LoaderContext } from "@renoxium/sdk";

import { shell } from "../../lib/page";
import { expireDue, listQuotes, STATUSES } from "../../lib/quotes";
import { day } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "quote.read" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const scoped = scopedDb(ctx.db, branch);
  await expireDue(scoped);
  const asked = ctx.url.searchParams.get("status") ?? "";
  const status = (STATUSES as readonly string[]).includes(asked) ? asked : "";
  const rows = await listQuotes(scoped, status);
  return {
    ...page,
    status,
    statuses: STATUSES.map((s) => ({ value: s, current: s === status })),
    quotes: rows.map((q) => ({ id: q.id, number: q.number, status: q.status, customer_name: q.customer_name, total: q.total_fils / 100, valid_until: day(q.valid_until) })),
  };
}
