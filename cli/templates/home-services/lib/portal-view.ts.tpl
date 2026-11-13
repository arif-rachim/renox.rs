// What the customer portal shows (#776): the job statuses and timeline events
// in the customer's words (one place: the `my.*` keys of i18n/*.json), and the
// views of `/my` (upcoming visits, past visits, contracts) and of
// `/my/visits/<id>`, read through `customerDb` only (lib/customer-db.ts).
// Staff-only data is never read into a view: job event notes and their
// authors, visit notes, costs, a staff job's description (only a
// self-booking's, which the customer wrote, is shown), and of the technician
// only the first name. Times are Dubai times (UTC+4, no daylight saving).
//
// No module is imported, so the tests can run the mapping and the views.
import type { Row } from "@renoxium/sdk";

import ar from "../i18n/ar.json";
import en from "../i18n/en.json";
import { daysBetween, RENEWAL_NOTICE_DAYS } from "./contract-dates";
import type { CustomerDb } from "./customer-db";

export type Lang = "en" | "ar";

const OFFSET_MS = 4 * 3_600_000;

/** The Dubai day `YYYY-MM-DD` of unix seconds. */
export const dayOf = (seconds: number): string => new Date(seconds * 1000 + OFFSET_MS).toISOString().slice(0, 10);
/** The Dubai time `HH:MM` of unix seconds. */
export const clockOf = (seconds: number): string => new Date(seconds * 1000 + OFFSET_MS).toISOString().slice(11, 16);
/** Today in Dubai. */
export const todayDubai = (nowMs = Date.now()): string => dayOf(Math.floor(nowMs / 1000));

const weekdayName = (lang: Lang, seconds: number): string => {
  const days = (lang === "ar" ? ar : en).backoffice.hours.day as Record<string, string>;
  return days[String(new Date(seconds * 1000 + OFFSET_MS).getUTCDay())] ?? "";
};

/** The statuses of the "Upcoming" list, and of "Past visits". */
export const UPCOMING = ["new", "scheduled", "en_route", "in_progress"] as const;
export const PAST = ["done", "invoiced", "cancelled"] as const;
/** At most this many upcoming visits; past visits are paged by this many. */
export const UPCOMING_MAX = 10;
export const PAGE_SIZE = 10;

/**
 * A job status in the customer's words: the `my.status.*` key. An invoiced job
 * is "Done" for the customer (the invoice is the next issue's page).
 */
export function statusKey(status: string): string {
  switch (status) {
    case "new":
      return "my.status.new";
    case "scheduled":
      return "my.status.scheduled";
    case "en_route":
      return "my.status.en_route";
    case "in_progress":
      return "my.status.in_progress";
    case "done":
    case "invoiced":
      return "my.status.done";
    case "cancelled":
      return "my.status.cancelled";
    default:
      return "my.status.unknown";
  }
}

/**
 * A timeline event in the customer's words: the `my.event.*` key of the status
 * the job moved to, or null for an event the customer does not see (a note or
 * an assignment without a status change, or the invoicing).
 */
export function eventKey(toStatus: string | null): string | null {
  switch (toStatus) {
    case "new":
      return "my.event.requested";
    case "scheduled":
      return "my.event.confirmed";
    case "en_route":
      return "my.event.en_route";
    case "in_progress":
      return "my.event.started";
    case "done":
      return "my.event.finished";
    case "cancelled":
      return "my.event.cancelled";
    default:
      return null;
  }
}

/** Whether `/my` reloads itself every minute: while a visit is on its way or in progress. */
export const isLive = (statuses: readonly string[]): boolean => statuses.some((s) => s === "en_route" || s === "in_progress");

const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** The lookups every view needs, read once per request. */
export interface Lookups {
  readonly lang: Lang;
  readonly sites: Map<string, Row>;
  readonly services: Map<string, Row>;
  readonly branches: Map<string, Row>;
  /** Whether the customer's rows are in more than one branch: each item is then marked with its branch. */
  readonly manyBranches: boolean;
}

export async function lookupsOf(cdb: CustomerDb, lang: Lang): Promise<Lookups> {
  const [sites, services, branches] = await Promise.all([cdb.sites(), cdb.services(), cdb.branches()]);
  return {
    lang,
    sites: new Map(sites.map((s) => [str(s.id), s])),
    services: new Map(services.map((s) => [str(s.id), s])),
    branches: new Map(branches.map((b) => [str(b.id), b])),
    manyBranches: branches.length > 1,
  };
}

const named = (row: Row | undefined, lang: Lang): string => (row === undefined ? "" : str(lang === "ar" ? row.name_ar : row.name_en));

/** The time of a job: its Dubai day, weekday and window, or none. */
function whenOf(job: Row, lang: Lang) {
  const start = num(job.scheduled_start);
  const end = num(job.scheduled_end);
  if (start === null) return { has_time: false, day: "", weekday: "", from: "", to: "" };
  return { has_time: true, day: dayOf(start), weekday: weekdayName(lang, start), from: clockOf(start), to: end === null ? "" : clockOf(end) };
}

/** What a job's line on `/my` shows, both lists. */
function lineOf(job: Row, l: Lookups) {
  const site = l.sites.get(str(job.site_id));
  return {
    id: str(job.id),
    number: str(job.number),
    status: str(job.status),
    status_key: statusKey(str(job.status)),
    service: named(l.services.get(str(job.service_id)), l.lang),
    site: str(site?.label),
    area: str(site?.area),
    branch: l.manyBranches ? named(l.branches.get(str(job.branch_id)), l.lang) : "",
    href: `/my/visits/${str(job.id)}`,
    ...whenOf(job, l.lang),
  };
}

/** The upcoming visits, soonest first (a job with no time yet last), at most UPCOMING_MAX, each with the technician's first name once scheduled. */
export async function upcomingOf(cdb: CustomerDb, jobs: readonly Row[], l: Lookups) {
  const open = jobs
    .filter((j) => (UPCOMING as readonly string[]).includes(str(j.status)))
    .sort((a, b) => (num(a.scheduled_start) ?? Number.MAX_SAFE_INTEGER) - (num(b.scheduled_start) ?? Number.MAX_SAFE_INTEGER) || str(a.number).localeCompare(str(b.number)))
    .slice(0, UPCOMING_MAX);
  const out = [];
  for (const j of open) {
    const waiting = str(j.status) === "new";
    out.push({ ...lineOf(j, l), waiting, technician: waiting ? "" : await cdb.technicianFirstName(str(j.id)) });
  }
  return out;
}

/** One page (1-based) of the past visits, newest first, and the paging links. */
export function pastOf(jobs: readonly Row[], l: Lookups, page: number) {
  const done = jobs
    .filter((j) => (PAST as readonly string[]).includes(str(j.status)))
    .sort((a, b) => (num(b.scheduled_start) ?? num(b.created_at) ?? 0) - (num(a.scheduled_start) ?? num(a.created_at) ?? 0) || str(b.number).localeCompare(str(a.number)));
  const pages = Math.max(1, Math.ceil(done.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const items = done.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map((j) => {
    const line = lineOf(j, l);
    // A visit that never got a time (cancelled before it was scheduled) is dated by its booking.
    return line.has_time ? line : { ...line, day: dayOf(num(j.created_at) ?? 0) };
  });
  return {
    items,
    page: current,
    pages,
    total: done.length,
    prev: current > 1 ? `/my?page=${current - 1}#past` : "",
    next: current < pages ? `/my?page=${current + 1}#past` : "",
  };
}

/** The page number of `?page=`, 1 when absent or not a positive whole number. */
export const pageOf = (raw: string | null): number => (raw !== null && /^[1-9]\d{0,4}$/u.test(raw) ? Number(raw) : 1);

/**
 * The active contracts: the number, the period, what is covered (service and
 * visits per year per site), the next planned visit (the earliest of the
 * visits made for it that are still to come, and the items' next visit days),
 * and whether it ends within RENEWAL_NOTICE_DAYS.
 */
export async function contractsOf(cdb: CustomerDb, jobs: readonly Row[], l: Lookups, today = todayDubai()) {
  const statusById = new Map(jobs.map((j) => [str(j.id), str(j.status)]));
  const out = [];
  for (const c of (await cdb.contracts()).filter((c) => str(c.status) === "active")) {
    const id = str(c.id);
    const items = await cdb.contractItems(id);
    const made = await cdb.contractJobs(id);
    const planned = [
      ...made.filter((m) => (UPCOMING as readonly string[]).includes(statusById.get(str(m.job_id)) ?? "") && str(m.due_on) >= today).map((m) => str(m.due_on)),
      ...items.map((i) => str(i.next_visit_on)).filter((d) => d >= today),
    ].sort();
    const left = daysBetween(today, str(c.ends_on));
    out.push({
      id,
      number: str(c.number),
      starts_on: str(c.starts_on),
      ends_on: str(c.ends_on),
      branch: l.manyBranches ? named(l.branches.get(str(c.branch_id)), l.lang) : "",
      items: items.map((i) => ({
        service: named(l.services.get(str(i.service_id)), l.lang),
        site: str(l.sites.get(str(i.site_id))?.label),
        visits_per_year: num(i.visits_per_year) ?? 0,
      })),
      next_visit: planned[0] ?? "",
      ends_soon: left >= 0 && left <= RENEWAL_NOTICE_DAYS,
    });
  }
  return out;
}

/**
 * `/my/visits/<id>`: one job of the customer, or null (another customer's id
 * too). The timeline in the customer's words with Dubai times, the address,
 * the notes the customer gave (a self-booking's description), the technician's
 * first name and the branch's name and phone.
 */
export async function visitOf(cdb: CustomerDb, jobId: string, lang: Lang) {
  const job = await cdb.job(jobId);
  if (job === null) return null;
  const l = await lookupsOf(cdb, lang);
  const site = l.sites.get(str(job.site_id));
  const branch = l.branches.get(str(job.branch_id));
  const timeline = [];
  for (const e of await cdb.jobEvents(jobId)) {
    const key = eventKey(e.to_status === null || e.to_status === undefined ? null : str(e.to_status));
    const at = num(e.at);
    if (key !== null && at !== null) timeline.push({ key, day: dayOf(at), time: clockOf(at) });
  }
  const status = str(job.status);
  return {
    ...lineOf(job, { ...l, manyBranches: false }),
    waiting: status === "new",
    done: status === "done" || status === "invoiced",
    address: site === undefined ? "" : [str(site.address), str(site.area)].filter((s) => s !== "").join(", "),
    notes: str(job.source) === "self_booking" ? str(job.description) : "",
    technician: status === "new" ? "" : await cdb.technicianFirstName(jobId),
    branch_name: named(branch, lang),
    branch_phone: str(branch?.phone),
    timeline,
  };
}

// ---------------------------------------------------------------- invoices and visit reports (#777)

/** Whether an invoice still asks for money: issued or part-paid (a paid or credited one does not). */
export const isOpen = (status: string): boolean => status === "issued" || status === "part-paid";

/** What is still to pay on an invoice, in fils (nothing on a paid or credited one). */
const owed = (r: { status: string; total_fils: number; paid_fils: number }): number => (isOpen(r.status) ? Math.max(0, r.total_fils - r.paid_fils) : 0);

/** The open invoices of the customer: how many, and what is left to pay on them in AED. */
export async function openInvoicesOf(cdb: CustomerDb) {
  const open = (await cdb.invoiceStates()).filter((r) => isOpen(r.status));
  return { count: open.length, sum: open.reduce((n, r) => n + owed(r), 0) / 100 };
}

/**
 * `/my/invoices`: one page (1-based, PAGE_SIZE a page) of the customer's
 * invoices, newest first. Every invoice there is issued: tax_gcc numbers an
 * invoice when it issues it, and the app keeps no draft invoice. Each line:
 * the number, the day, what it is for (the job's service, or the contract's
 * number), the total with VAT in AED, and the state: paid (on the day of the
 * last payment), open (with its due day) or credited. On top: how many are
 * open and what is left to pay on them.
 */
export async function invoicesOf(cdb: CustomerDb, l: Lookups, page: number) {
  const states = await cdb.invoiceStates();
  const maps = new Map((await cdb.invoices()).map((i) => [str(i.invoice_id), i]));
  const jobs = new Map((await cdb.jobs()).map((j) => [str(j.id), j]));
  const contracts = new Map((await cdb.contracts()).map((c) => [str(c.id), c]));
  const pages = Math.max(1, Math.ceil(states.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const items = [];
  for (const r of states.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)) {
    const contract = contracts.get(str(maps.get(r.invoice_id)?.contract_id));
    const job = r.job_id === null ? undefined : jobs.get(r.job_id);
    let paidOn = "";
    if (r.status === "paid") {
      const last = (await cdb.payments(r.invoice_id)).map((p) => num(p.received_at) ?? 0).sort((a, b) => b - a)[0];
      paidOn = last === undefined ? "" : dayOf(last);
    }
    items.push({
      id: r.invoice_id,
      day: dayOf(r.created_at),
      service: job === undefined ? "" : named(l.services.get(str(job.service_id)), l.lang),
      contract: contract === undefined ? "" : str(contract.number),
      total: r.total_fils / 100,
      state: r.status === "paid" ? "paid" : r.status === "credited" ? "credited" : "open",
      paid_on: paidOn,
      due: dayOf(r.due_at),
      href: `/my/invoices/${r.invoice_id}`,
    });
  }
  const open = states.filter((r) => isOpen(r.status));
  return {
    items,
    page: current,
    pages,
    total: states.length,
    open_count: open.length,
    open_sum: open.reduce((n, r) => n + owed(r), 0) / 100,
    prev: current > 1 ? `/my/invoices?page=${current - 1}` : "",
    next: current < pages ? `/my/invoices?page=${current + 1}` : "",
  };
}

/** The payment instructions in the page's language as lines (the other language's when that one is empty, as the brand name falls back); none hides the block. */
export function instructionsIn(texts: { en: string; ar: string }, lang: Lang): string[] {
  const own = (lang === "ar" ? texts.ar : texts.en).trim();
  const text = own !== "" ? own : (lang === "ar" ? texts.en : texts.ar).trim();
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** What `<x-image>` takes for one stored photo (the page signs it: lib/visit-data.ts imageOf). */
export type PhotoSigner = (photo: { file_key: string; width: number; height: number }) => Promise<unknown>;

/**
 * The report of a done visit on `/my/visits/<id>` (#777): what was done (the
 * summary in the page's language), the parts used with their quantities (no
 * prices), the photos before and after (a thumbnail through `<x-image>` and
 * the ownership-checked link `/my/visits/<job>/photo/<n>`, n from 1 in the
 * order taken), and who signed, when (the signature is taken at check-out).
 * Null when the job is another customer's or its visit is not checked out.
 * The technician's notes are never read.
 */
export async function reportOf(cdb: CustomerDb, jobId: string, lang: Lang, sign: PhotoSigner) {
  const visit = await cdb.visitOfJob(jobId);
  const out = visit === null ? null : num(visit.checkout_at);
  if (visit === null || out === null) return null;
  const own = str(lang === "ar" ? visit.summary_ar : visit.summary_en);
  const summary = own !== "" ? own : str(lang === "ar" ? visit.summary_en : visit.summary_ar);
  const shown = [];
  for (const [i, p] of (await cdb.visitPhotos(jobId)).entries()) {
    const width = num(p.width);
    const height = num(p.height);
    shown.push({
      phase: str(p.phase),
      caption: str(p.caption),
      href: `/my/visits/${jobId}/photo/${i + 1}`,
      image: width !== null && height !== null ? await sign({ file_key: str(p.file_key), width, height }) : null,
    });
  }
  const parts = (await cdb.visitParts(jobId)).map((p) => ({ description: str(p.description), qty: num(p.qty) ?? 0 }));
  return {
    summary,
    parts,
    has_parts: parts.length > 0,
    before: shown.filter((p) => p.phase === "before"),
    after: shown.filter((p) => p.phase === "after"),
    signed_by: str(visit.signed_by_name),
    signed_day: dayOf(out),
    signed_time: clockOf(out),
    pdf: `/my/visits/${jobId}/report`,
  };
}
