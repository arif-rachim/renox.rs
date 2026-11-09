// GET /me: the signed-in technician's visits for today (Dubai time): their
// jobs scheduled today, and any job of theirs that is still open from an
// earlier day (en route or in progress). `visit.perform`; the branch-scoped
// database and the technician filter keep it to their own work.
import type { LoaderContext } from "@renoxium/sdk";

import { clock, OFFSET_MS } from "../../lib/booking-sync";
import { shell } from "../../lib/page";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "visit.perform" };

type Row = { id: string; number: string; status: string; scheduled_start: number | null; customer_id: string; service_id: number; site_id: string };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const sdb = scopedDb(ctx.db, branch);
  const midnight = Math.floor((Math.floor((Date.now() + OFFSET_MS) / 86_400_000) * 86_400_000 - OFFSET_MS) / 1000);
  // Statements of an owned table stay single-table: the fence adds its own predicate.
  const rows = await sdb.query<Row>(
    `select id, number, status, scheduled_start, customer_id, service_id, site_id from app__jobs
      where technician_user_id = ?1 and status != 'cancelled' and status != 'new'
        and ((scheduled_start >= ?2 and scheduled_start < ?2 + 86400) or status in ('en_route', 'in_progress'))
      order by scheduled_start, number`,
    [ctx.principal?.id ?? "-", midnight],
  );
  const customers = new Map((await sdb.query<{ id: string; name: string }>("select id, name from app__customers", [])).map((c) => [c.id, c.name]));
  const sites = new Map((await sdb.query<{ id: string; label: string; area: string }>("select id, label, area from app__sites", [])).map((s) => [s.id, `${s.label} · ${s.area}`]));
  const services = new Map((await ctx.db.query<{ id: number; name_en: string; name_ar: string }>("select id, name_en, name_ar from app__services", [])).map((s) => [s.id, page.locale === "ar" ? s.name_ar : s.name_en]));
  return {
    ...page,
    visits: rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      time: r.scheduled_start === null ? "" : clock(r.scheduled_start),
      customer: customers.get(r.customer_id) ?? "",
      service: services.get(r.service_id) ?? "",
      site: sites.get(r.site_id) ?? "",
    })),
  };
}
