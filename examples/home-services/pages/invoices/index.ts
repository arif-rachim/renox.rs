// GET /invoices: the active branch's tax invoices, newest first, filtered by
// `?status=open|part-paid|paid|issued|credited|overdue` ("open" is issued or
// part-paid; "overdue" is open past its due date). `invoice.read`: accountant,
// branch manager, owner. Rows come through the branch-scoped database.
import type { LoaderContext } from "@renoxium/sdk";

import { invoiceView } from "../../lib/invoice-view";
import { listInvoices, STATUSES } from "../../lib/invoices";
import { shell } from "../../lib/page";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "invoice.read" };

const FILTERS = ["open", "overdue", ...STATUSES] as const;

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const asked = ctx.url.searchParams.get("status") ?? "";
  const status = (FILTERS as readonly string[]).includes(asked) ? (asked as (typeof FILTERS)[number]) : "";
  const rows = await listInvoices(scopedDb(ctx.db, branch), branch.id, status);
  return {
    ...page,
    status,
    statuses: FILTERS.map((s) => ({ value: s, current: s === status })),
    invoices: rows.map((r) => ({ ...invoiceView(r), customer_id: r.customer_id, customer_name: r.customer_name, state: r.overdue ? "overdue" : r.status })),
  };
}
