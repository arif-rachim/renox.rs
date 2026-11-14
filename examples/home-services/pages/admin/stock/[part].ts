// GET /admin/stock/<part>: the move history of one part in one branch (#813), newest first, 50 to a page (`?page=`),
// the branch chosen with `?branch=<id>` (a branch the user belongs to and may read; the active one when none; any
// other is a 404). `stock.read` opens it. Each move: when, what it was in words, the quantity with its sign, the
// balance after (a balance under zero is flagged), the cost, the reason, what caused it (a visit links to its job, a
// purchase order to /admin/purchasing/<id>, a transfer shows its id) and who made it. Read only: moves are made on
// /admin/stock, from a visit and from a purchase order.
import type { LoaderContext } from "@renoxium/sdk";

import { shell } from "../../../lib/page";
import { getPart, isPartId } from "../../../lib/parts";
import { branchDb } from "../../../lib/scope";
import { heldBranches, listMoves, qtyText, type MoveLine } from "../../../lib/stock";

export const guard = { action: "stock.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** Dubai time (UTC+4, no daylight saving), as the WhatsApp page prints it. */
const when = (seconds: number): string => new Date(seconds * 1000 + 4 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

type Ref = { label: string; text: string; href: string };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const part = isPartId(ctx.params.part) ? await getPart(ctx.db, ctx.params.part) : null;
  if (part === null) return plain(404, "Part not found");
  const held = (await heldBranches(ctx)).filter((b) => b.can_read);
  const wanted = (ctx.url.searchParams.get("branch") ?? "").trim();
  const branch = wanted === "" ? (held.find((b) => b.org_id === ctx.principal?.attrs.org) ?? held[0] ?? null) : (held.find((b) => b.id === wanted) ?? null);
  if (branch === null) return plain(404, "Branch not found");
  const ar = page.locale === "ar";
  const listing = await listMoves(ctx.db, branch.id, part.id, { page: Number(ctx.url.searchParams.get("page") ?? "1") });
  const sdb = branchDb(ctx.db, branch.id);

  const names = new Map<string, string>();
  for (const id of new Set(listing.rows.map((m) => m.created_by))) {
    const u = await ctx.db.queryOne<{ display_name: string | null; email: string }>("select display_name, email from auth__public_users_v1 where id = ?", [id]);
    names.set(id, (u?.display_name ?? "") !== "" ? (u?.display_name as string) : (u?.email ?? id));
  }
  /** What caused the move: a label key, its text and a link where there is a page for it. */
  const refOf = async (m: MoveLine): Promise<Ref> => {
    if (m.ref_kind === "visit" && m.ref_id !== null) {
      const visit = await sdb.queryOne<{ job_id: string }>("select job_id from app__visits where id = ?", [m.ref_id]);
      const job = visit === null ? null : await sdb.queryOne<{ id: string; number: string }>("select id, number from app__jobs where id = ?", [visit.job_id]);
      return { label: "stock.ref.visit", text: job?.number ?? m.ref_id, href: job === null ? "" : `/jobs/${job.id}` };
    }
    if (m.ref_kind === "purchase" && m.ref_id !== null) return { label: "stock.ref.purchase", text: m.ref_id, href: `/admin/purchasing/${m.ref_id}` };
    if (m.ref_kind === "transfer" && m.ref_id !== null) return { label: "stock.ref.transfer", text: m.ref_id, href: "" };
    return { label: "stock.ref.manual", text: "", href: "" };
  };
  const moves = [];
  for (const m of listing.rows) {
    const ref = await refOf(m);
    moves.push({
      id: m.id,
      at: when(m.created_at),
      kind: m.kind,
      qty: `${m.signed > 0 ? "+" : "-"}${qtyText(Math.abs(m.signed))}`,
      balance: qtyText(m.balance_after),
      flagged: m.flagged,
      has_cost: m.unit_cost_fils !== null,
      cost: (m.unit_cost_fils ?? 0) / 100,
      reason: m.reason,
      ref,
      who: names.get(m.created_by) ?? m.created_by,
    });
  }
  const href = (n: number): string => `/admin/stock/${part.id}?branch=${branch.id}&page=${n}`;
  return {
    ...page,
    part: { id: part.id, sku: part.sku, name: ar ? part.name_ar : part.name_en, unit: part.unit },
    branch_id: branch.id,
    branch_name: ar ? branch.name_ar : branch.name_en,
    back_href: `/admin/stock?branch=${branch.id}`,
    moves,
    total: listing.total,
    page_no: listing.page,
    pages: listing.pages,
    prev_href: listing.page > 1 ? href(listing.page - 1) : "",
    next_href: listing.page < listing.pages ? href(listing.page + 1) : "",
  };
}
