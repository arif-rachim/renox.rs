// GET /jobs/:id: one job of the active branch with its timeline. `job.read`;
// another branch's job is a 404, and a technician's page of a job that is not
// theirs is a 403 (the policy of renox.toml's Job entity).
//
// The schedule form is a slot picker: `?day=YYYY-MM-DD&technician=<user id>`
// lists the free starts `booking` offers that day (the branch's hours, the
// technician's free time), and POST ?/schedule books one. POST ?/assign,
// ?/cancel and ?/status need `job.dispatch`; a refusal of the rules answers
// 409 (a taken slot names the next free one) or 422 with the reason.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { bookingService, clock, ensureSynced, slotsOn } from "../../lib/booking-sync";
import { findCustomer } from "../../lib/customers";
import { check } from "../../lib/forms";
import { assignSchema, scheduleSchema, statusSchema } from "../../lib/job-forms";
import { assign, eventsOf, findJob, jobResource, schedule, TRANSITIONS, transition, type JobRow, type Outcome } from "../../lib/jobs";
import { shell } from "../../lib/page";
import { unprocessable } from "../../lib/problems";
import { day } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb, type Branch } from "../../lib/scope";
import { techniciansOf } from "../../lib/technicians";

export const guard = { action: "job.read" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const when = (seconds: number): string => `${day(seconds)} ${clock(seconds)}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

async function view(ctx: LoaderContext | ActionContext, branch: Branch, locale: string, job: JobRow) {
  const scoped = scopedDb(ctx.db, branch);
  const customer = await findCustomer(scoped, job.customer_id);
  const site = await scoped.queryOne<{ label: string; area: string; address: string }>("select label, area, address from app__sites where id = ?", [job.site_id]);
  const quote = job.quote_id === null ? null : await scoped.queryOne<{ id: string; number: string }>("select id, number from app__quotes where id = ?", [job.quote_id]);
  const service = await ctx.db.queryOne<{ code: string; name_en: string; name_ar: string }>("select code, name_en, name_ar from app__services where id = ?", [job.service_id]);
  const dispatcher = await ctx.authz.can("job.dispatch");
  const names = new Map<string, string>();
  let technicians: { id: string; name: string }[] = [];
  if (dispatcher) technicians = await techniciansOf(ctx, branch);
  for (const t of technicians) names.set(t.id, t.name);
  const events = await eventsOf(scoped, job.id);
  const open = job.status === "new" || job.status === "scheduled";
  // The slot picker: a day (the job's day, else tomorrow) and a technician (the job's, else all of them).
  const url = ctx.url;
  const askedDay = url.searchParams.get("day") ?? "";
  const pickDay = DAY.test(askedDay) ? askedDay : day(job.scheduled_start ?? Math.floor(Date.now() / 1000) + 86400);
  const askedTech = url.searchParams.get("technician") ?? "";
  const pickTech = technicians.some((t) => t.id === askedTech) ? askedTech : (job.technician_user_id ?? "");
  let slots: { value: string; label: string }[] = [];
  if (dispatcher && open && service !== null) {
    await ensureSynced(ctx.db, branch, technicians);
    const staff = pickTech === "" ? technicians.map((t) => t.id) : [pickTech];
    const found = await slotsOn(bookingService(service.code), pickDay, staff);
    slots = found.map((s) => ({ value: `${s.staff}@${s.start}`, label: `${clock(Math.floor(s.start / 1000))}–${clock(Math.floor(s.end / 1000))} · ${names.get(s.staff) ?? s.staff}` }));
  }
  return {
    job: {
      id: job.id,
      number: job.number,
      status: job.status,
      priority: job.priority,
      description: job.description,
      start: job.scheduled_start === null ? "" : when(job.scheduled_start),
      end: job.scheduled_end === null ? "" : clock(job.scheduled_end),
      technician: job.technician_user_id === null ? "" : (names.get(job.technician_user_id) ?? job.technician_user_id),
      service: service === null ? "" : locale === "ar" ? service.name_ar : service.name_en,
      created_at: when(job.created_at),
    },
    customer: customer === null ? null : { id: customer.id, name: customer.name, phone: customer.phone },
    site,
    quote,
    events: events.map((e) => ({
      id: e.id,
      at: when(e.at),
      from: e.from_status,
      to: e.to_status,
      created: e.from_status === null,
      note: e.note,
      by: e.by_user_id === null ? "" : (names.get(e.by_user_id) ?? ""),
    })),
    can_dispatch: dispatcher,
    can_schedule: dispatcher && open,
    can_cancel: dispatcher && TRANSITIONS[job.status].includes("cancelled"),
    // The statuses the table allows next, except the two with their own forms.
    next: dispatcher ? TRANSITIONS[job.status].filter((s) => s !== "scheduled" && s !== "cancelled") : [],
    technicians: technicians.map((t) => ({ id: t.id, name: t.name, picked: t.id === pickTech, assigned: t.id === job.technician_user_id })),
    pick_day: pickDay,
    slots,
  };
}

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const job = await findJob(scopedDb(ctx.db, branch), ctx.params.id);
  if (job === null) return plain(404, "Job not found");
  await ctx.authz.require("job.read", jobResource(job, ctx.principal?.id ?? null));
  return { ...page, ...(await view(ctx, branch, page.locale, job)) };
}

/** The refusal of `job.dispatch` as the 403 the route would answer, or null when allowed. */
async function denied(ctx: ActionContext): Promise<Response | null> {
  try {
    await ctx.authz.require("job.dispatch");
    return null;
  } catch (e) {
    if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return plain(403, "Forbidden");
    throw e;
  }
}

/** A successful change answers by redirecting to the job (a reload shows the new timeline); a refusal is its status with the reason. */
const answer = (r: Outcome, back: string): Response => (r.ok ? new Response(null, { status: 303, headers: { location: back, "cache-control": "no-store" } }) : plain(r.status, r.message));

export const actions = {
  async schedule(ctx: ActionContext) {
    const page = await shell(ctx);
    const refused = await denied(ctx);
    if (refused !== null) return refused;
    const input = await check(ctx.form, scheduleSchema);
    if ("errors" in input) return unprocessable(page.locale, input.errors, `/jobs/${ctx.params.id}`);
    return answer(await schedule(ctx, ctx.params.id, input.value.technician, input.value.start, input.value.note), `/jobs/${ctx.params.id}`);
  },

  async assign(ctx: ActionContext) {
    const page = await shell(ctx);
    const refused = await denied(ctx);
    if (refused !== null) return refused;
    const input = await check(ctx.form, assignSchema);
    if ("errors" in input) return unprocessable(page.locale, input.errors, `/jobs/${ctx.params.id}`);
    return answer(await assign(ctx, ctx.params.id, input.value.technician), `/jobs/${ctx.params.id}`);
  },

  async cancel(ctx: ActionContext) {
    const refused = await denied(ctx);
    if (refused !== null) return refused;
    const note = String(ctx.form.get("note") ?? "").trim().slice(0, 200);
    return answer(await transition(ctx, ctx.params.id, "cancelled", note), `/jobs/${ctx.params.id}`);
  },

  async status(ctx: ActionContext) {
    const page = await shell(ctx);
    const refused = await denied(ctx);
    if (refused !== null) return refused;
    const input = await check(ctx.form, statusSchema);
    if ("errors" in input) return unprocessable(page.locale, input.errors, `/jobs/${ctx.params.id}`);
    return answer(await transition(ctx, ctx.params.id, input.value.to, input.value.note), `/jobs/${ctx.params.id}`);
  },
};
