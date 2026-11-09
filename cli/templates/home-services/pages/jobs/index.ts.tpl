// GET /jobs: the active branch's jobs, filtered by status, technician and day
// (`?status=scheduled&technician=<user id>&day=2026-11-09`). The guard is
// `job.read`; a technician sees only the jobs assigned to them (the policy
// refuses the others, and the list is cut to the same set), everyone else with
// `job.read` sees the branch's.
import type { LoaderContext } from "@renoxium/sdk";

import { clock } from "../../lib/booking-sync";
import { listJobs, PRIORITIES, readsAll, STATUSES } from "../../lib/jobs";
import { shell } from "../../lib/page";
import { day } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";
import { techniciansOf } from "../../lib/technicians";

export const guard = { action: "job.read" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const all = await readsAll(ctx.authz, branch.id);
  const asked = ctx.url.searchParams.get("status") ?? "";
  const status = (STATUSES as readonly string[]).includes(asked) ? asked : "";
  const askedDay = ctx.url.searchParams.get("day") ?? "";
  const dayKey = /^\d{4}-\d{2}-\d{2}$/u.test(askedDay) ? askedDay : "";
  const askedTech = ctx.url.searchParams.get("technician") ?? "";
  const technicians = all ? await techniciansOf(ctx, branch) : [];
  const technician = technicians.some((t) => t.id === askedTech) ? askedTech : "";
  const rows = await listJobs(scopedDb(ctx.db, branch), { status, technician, day: dayKey }, all ? null : (ctx.principal?.id ?? "-"));
  const scoped = scopedDb(ctx.db, branch);
  const customers = new Map((await scoped.query<{ id: string; name: string }>("select id, name from app__customers", [])).map((c) => [c.id, c.name]));
  const services = new Map((await ctx.db.query<{ id: number; name_en: string; name_ar: string }>("select id, name_en, name_ar from app__services", [])).map((s) => [s.id, page.locale === "ar" ? s.name_ar : s.name_en]));
  const names = new Map(technicians.map((t) => [t.id, t.name]));
  return {
    ...page,
    all,
    status,
    day: dayKey,
    technician,
    statuses: STATUSES.map((s) => ({ value: s, current: s === status })),
    priorities: PRIORITIES,
    technicians: technicians.map((t) => ({ id: t.id, name: t.name, current: t.id === technician })),
    jobs: rows.map((j) => ({
      id: j.id,
      number: j.number,
      status: j.status,
      priority: j.priority,
      customer: customers.get(j.customer_id) ?? "",
      service: services.get(j.service_id) ?? "",
      technician: j.technician_user_id === null ? "" : (names.get(j.technician_user_id) ?? ""),
      start: j.scheduled_start === null ? "" : `${day(j.scheduled_start)} ${clock(j.scheduled_start)}`,
    })),
  };
}
