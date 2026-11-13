// GET /my/visits/<job id>: one visit of the signed-in customer (#776), for a
// portal user only (lib/portal.ts requirePortal, as on /my). Another
// customer's job, or an id that is not one, is a 404 (never a 403: the page
// does not tell that the id exists). The timeline in the customer's words,
// the time, the address, the notes they gave when they booked, the
// technician's first name and the branch's phone (lib/portal-view.ts
// visitOf, through `customerDb` only). Internal notes, costs, other
// customers' names and the technician's last name or phone are never read.
// A done visit also shows its report (#777, lib/portal-view.ts reportOf):
// what was done, the parts used with their quantities (no prices), the photos
// before and after, who signed and when, and "Download report (PDF)"
// (/my/visits/<id>/report). A thumbnail goes through `<x-image>`, whose URL
// is the platform's image path with a link signed for an hour, made here only
// for a photo customerDb found on this customer's visit; each thumbnail links
// to /my/visits/<id>/photo/<n>, which checks the session on every request.
//
// Cancel and reschedule (#778, action `portal.change`; requirePortal is the
// gate, as on every /my page). lib/portal-change.ts `canChange` decides,
// from the company's cut-off and move limit: when allowed, "Change the time"
// (`?change=1`: the day row and the free slots of /book step 2, lib/book.ts
// freeSlots, for the job's branch and service, without its current slot) and
// "Cancel this visit" (`?cancel=1`: a confirmation with an optional reason);
// when not, one sentence why and the branch's phone. POST ?/reschedule and
// ?/cancel re-read the job through customerDb (`customer_id = ? and id = ?`)
// and ask `canChange` again inside the action's transaction; the change
// itself is the dispatcher's own (lib/jobs.ts scheduleJob, requestTime,
// transitionJob) on the fenced database customerDb holds for the customer's
// branch. A change that lost a race (the slot was taken, or the cut-off
// passed while the form was open) answers 409 with the reason and the links
// again, and changes nothing. The customer gets a WhatsApp message, the
// branch's dispatchers and the technician (old and new) an in-app
// notification, and the board its card over the WebSocket.
import { redirect, type ActionContext, type LoaderContext } from "@renoxium/sdk";
import { storage } from "renox:modules";

import ar from "../../../i18n/ar.json";
import en from "../../../i18n/en.json";
import { dispatchersOf, freeSlots, nextDays, parseSlot, type FreeSlot } from "../../../lib/book";
import type { ChangeTarget, CustomerDb } from "../../../lib/customer-db";
import { invalid } from "../../../lib/invalid";
import { requestTime, scheduleJob, transitionJob } from "../../../lib/jobs";
import { notifyCustomer, notifyStaff } from "../../../lib/notify";
import { shell } from "../../../lib/page";
import { CANCELLED, canChange, cancelReasonOf, type ChangeReason, reasonKey, RESCHEDULED } from "../../../lib/portal-change";
import { clockOf, dayOf, reportOf, visitOf } from "../../../lib/portal-view";
import { requirePortal, signOut } from "../../../lib/portal";
import { imageOf } from "../../../lib/visit-data";

type Ctx = LoaderContext | ActionContext;
type Lang = "en" | "ar";

const notFound = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
const jobIdOf = (raw: unknown): string | null => (typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(raw) ? raw : null);
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const when = (seconds: number): string => `${dayOf(seconds)} ${clockOf(seconds)}`;

const weekdayName = (lang: Lang, weekday: number): string => {
  const days = (lang === "ar" ? ar : en).backoffice.hours.day as Record<string, string>;
  return days[String(weekday)] ?? String(weekday);
};

/** What the customer may do with the job now. */
async function answerOf(cdb: CustomerDb, target: ChangeTarget) {
  const rules = await cdb.changeRules();
  const can = canChange({ status: target.job.status, scheduled_start: target.job.scheduled_start, source: target.job.source, reschedules: target.reschedules }, nowSeconds(), rules);
  return { can, rules };
}

/** The links, or the sentence why not, of the visit page. */
function changeView(id: string, target: ChangeTarget, answer: Awaited<ReturnType<typeof answerOf>>) {
  const { can, rules } = answer;
  return {
    can_reschedule: can.reschedule,
    can_cancel: can.cancel,
    reason: can.reason,
    // A visit that is over (done, cancelled) needs no sentence; one that cannot change any more does.
    why: can.reason === "ok" || can.reason === "not_scheduled" ? "" : reasonKey(can.reason),
    hours: String(rules.cutoff_hours),
    moves: String(target.reschedules),
    phone: target.branch.phone,
    href_change: `/my/visits/${id}?change=1`,
    href_cancel: `/my/visits/${id}?cancel=1`,
    href_back: `/my/visits/${id}`,
  };
}

/** `?change=1`: the next days as links and the chosen day's free slots for the job's branch and service, without the job's current slot. */
async function slotsView(ctx: Ctx, id: string, target: ChangeTarget, lang: Lang, askedDay: string, picked = "") {
  const days = nextDays();
  const chosen = days.find((d) => d.key === askedDay) ?? (days[0] as { key: string; weekday: number });
  const current = target.job.scheduled_start === null ? null : target.job.scheduled_start * 1000;
  const slots = (await freeSlots(ctx, target.branch, { code: target.service_code }, chosen.key)).filter((s) => s.start !== current);
  return {
    step: "change",
    pending: target.job.status === "new",
    day: chosen.key,
    day_label: weekdayName(lang, chosen.weekday),
    days: days.map((d) => ({ key: d.key, label: weekdayName(lang, d.weekday), current: d.key === chosen.key, href: `/my/visits/${id}?change=1&day=${d.key}` })),
    slots: slots.map((s) => ({ value: s.value, from: s.from, to: s.to, checked: s.value === picked })),
  };
}

export async function load(ctx: LoaderContext) {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const id = jobIdOf(ctx.params.id);
  if (id === null) return notFound();
  const page = await shell(ctx);
  const lang: Lang = page.locale === "ar" ? "ar" : "en";
  const visit = await visitOf(gate.cdb, id, lang);
  if (visit === null) return notFound();
  // A photo row whose file is not stored (yet) has no thumbnail, only its link: signing it would throw.
  const sign = (p: { file_key: string; width: number; height: number }) => imageOf(ctx.storage, p, 3600, storage).catch(() => null);
  const report = visit.done ? await reportOf(gate.cdb, id, lang, sign) : null;
  const target = await gate.cdb.changeTarget(id);
  if (target === null) return notFound();
  const answer = await answerOf(gate.cdb, target);
  const change = changeView(id, target, answer);
  const q = ctx.url.searchParams;
  const done = q.get("changed");
  const base = { ...page, visit, report, change, step: "", conflict: "", notice: done === "moved" || done === "cancelled" ? `my.change.done.${done}` : "", values: {}, errors: {}, problems: [] as unknown[] };
  if (q.get("change") === "1" && answer.can.reschedule) return { ...base, ...(await slotsView(ctx, id, target, lang, q.get("day") ?? "")) };
  if (q.get("cancel") === "1" && answer.can.cancel) return { ...base, step: "cancel" };
  return base;
}

/** A refusal re-renders the page (its loader: the links again, or why not) with the reason: 409, nothing changed. */
const conflict = (reason: ChangeReason | "taken" | "changed") => ({ status: 409 as const, conflict: reason === "taken" || reason === "changed" ? `my.change.conflict.${reason}` : reasonKey(reason) });

/** The reason a customer gave, for the dispatcher's timeline (in English, as the staff notes are). */
const REASON_NOTE: Record<string, string> = { "": "no reason given", no_longer_needed: "no longer needed", found_other_time: "found another time by phone", other: "other" };

/** The branch's dispatchers and the technicians concerned (old and new, once each) are told in the app. */
async function tellStaff(ctx: ActionContext, target: ChangeTarget, technicians: (string | null)[], title: string): Promise<void> {
  const link = `/jobs/${target.job.id}`;
  await notifyStaff(await dispatchersOf(ctx, target.branch), { category: "jobs", title, link });
  await notifyStaff(
    technicians.filter((t): t is string => t !== null),
    { category: "jobs", title, link: `/me/visits/${target.job.id}` },
  );
}

export const actions = {
  /** `portal.change`: the visit moves to the slot picked on `?change=1`. */
  async reschedule(ctx: ActionContext) {
    const gate = await requirePortal(ctx);
    if (gate instanceof Response) return gate;
    const id = jobIdOf(ctx.params.id);
    if (id === null) return notFound();
    const page = await shell(ctx);
    const lang: Lang = page.locale === "ar" ? "ar" : "en";
    const raw = ctx.form.get("slot");
    const slot = typeof raw === "string" ? raw : "";
    const parsed = parseSlot(slot);
    const out = await gate.cdb.reschedule(id, async (sdb, target) => {
      const { can } = await answerOf(gate.cdb, target);
      if (!can.reschedule) return conflict(can.reason);
      if (parsed === null) {
        const bad = invalid(page.locale, ctx.form, { slot: "book.err.slot" });
        return { ...bad, ...(await slotsView(ctx, id, target, lang, ctx.form.get("day")?.toString() ?? "")) };
      }
      // The slot must be one ?change=1 offers now: free in `booking` for a technician of the job's branch, and not the current one.
      const dayKey = dayOf(Math.floor(parsed.start / 1000));
      const current = target.job.scheduled_start === null ? null : target.job.scheduled_start * 1000;
      const offered: FreeSlot | undefined = parsed.start === current ? undefined : (await freeSlots(ctx, target.branch, { code: target.service_code }, dayKey)).find((s) => s.value === slot);
      if (offered === undefined) return conflict("taken");
      const job = target.job;
      const from = job.scheduled_start === null ? "no time" : when(job.scheduled_start);
      const to = when(Math.floor(offered.start / 1000));
      const event = `${RESCHEDULED}: from ${from} to ${to}`;
      if (job.status === "scheduled") {
        // The dispatcher's move: the old booking released, the new one booked with the slot's technician, the customer told (visit_moved).
        const moved = await scheduleJob(ctx, target.branch, sdb, job, offered.staff, offered.start, { event, sync: false, message: "visit_moved" });
        if (!moved.ok) return conflict(moved.status === 409 ? "taken" : "changed");
        await tellStaff(ctx, target, [job.technician_user_id, moved.job.technician_user_id], `Visit ${job.number} moved by the customer to ${to}`);
      } else {
        // A `new` job keeps waiting for the dispatcher, with the new requested time.
        const asked = await requestTime(ctx, target.branch, sdb, job, offered.start, offered.end, event);
        if (!asked.ok) return conflict("changed");
        await notifyCustomer(ctx, { id: job.customer_id }, "visit_moved", { branch_id: target.branch.id, ref_id: job.id, job_id: job.id, vars: { job: job.number, when: to } });
        await tellStaff(ctx, target, [job.technician_user_id], `Visit ${job.number} moved by the customer to ${to}`);
      }
      return redirect.safe(`/my/visits/${target.job.id}?changed=moved`, { status: 303, fallback: "/my" });
    });
    return out ?? notFound();
  },

  /** `portal.change`: the visit is cancelled, with the reason picked on `?cancel=1`. */
  async cancel(ctx: ActionContext) {
    const gate = await requirePortal(ctx);
    if (gate instanceof Response) return gate;
    const id = jobIdOf(ctx.params.id);
    if (id === null) return notFound();
    const page = await shell(ctx);
    const input = cancelReasonOf(ctx.form);
    const out = await gate.cdb.cancel(id, async (sdb, target) => {
      const { can } = await answerOf(gate.cdb, target);
      if (!can.cancel) return conflict(can.reason);
      if ("errors" in input) return { ...invalid(page.locale, ctx.form, input.errors), step: "cancel" };
      const job = target.job;
      const why = REASON_NOTE[input.value.reason] ?? "other";
      const cancelled = await transitionJob(ctx, target.branch, sdb, job, "cancelled", `${CANCELLED}: ${why}${input.value.text === "" ? "" : `: ${input.value.text}`}`);
      if (!cancelled.ok) return conflict("changed");
      await notifyCustomer(ctx, { id: job.customer_id }, "visit_cancelled", { branch_id: target.branch.id, ref_id: job.id, job_id: job.id, vars: { job: job.number } });
      await tellStaff(ctx, target, [job.technician_user_id], `Visit ${job.number} cancelled by the customer`);
      return redirect.safe(`/my/visits/${target.job.id}?changed=cancelled`, { status: 303, fallback: "/my" });
    });
    return out ?? notFound();
  },

  async signout() {
    return signOut();
  },
};
