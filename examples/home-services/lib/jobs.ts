// Jobs: statements, the state machine and scheduling. A job of the branch is
// read and written through the branch-scoped Db of lib/scope.ts (the fence adds
// branch_id); the number sequence and the catalogue take the plain one.
//
// Every status change goes through `transition`: the allowed-transitions table,
// a row of app__job_events, an audit record, and the re-rendered card published
// to the branch's dispatch board (functions/ws/dispatch/[branch].ts). Who may
// ask for a change is the caller's to check (`job.dispatch` on the pages,
// `visit.perform` on the technician's visit); this file checks the table.
import type { ActionContext, Db, DbStatements, Principal, Realtime } from "@renoxium/sdk";
import { audit } from "renox:modules";

import { bookingService, bookVisit, cancelVisit, clock, ensureSynced, isTaken, nextFree, OFFSET_MS, slotsOn } from "./booking-sync";
import { notifyCustomer } from "./notify";
import { day as dayOf } from "./quotes";
import { branchOf, scopedDb, type Branch } from "./scope";
import { memberName, techniciansOf } from "./technicians";

export const STATUSES = ["new", "scheduled", "en_route", "in_progress", "done", "invoiced", "cancelled"] as const;
export type JobStatus = (typeof STATUSES)[number];
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** What each status may become. `scheduled -> scheduled` (a move) is not a transition: `schedule` does it. */
export const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  new: ["scheduled", "cancelled"],
  scheduled: ["new", "en_route", "in_progress", "cancelled"],
  en_route: ["scheduled", "in_progress", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: ["invoiced"],
  invoiced: [],
  cancelled: [],
};

export type JobRow = {
  id: string;
  branch_id: string;
  customer_id: string;
  site_id: string;
  quote_id: string | null;
  number: string;
  status: JobStatus;
  priority: Priority;
  service_id: number;
  description: string;
  scheduled_start: number | null;
  scheduled_end: number | null;
  technician_user_id: string | null;
  booking_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
};

export type EventRow = { id: number; at: number; by_user_id: string | null; from_status: JobStatus | null; to_status: JobStatus | null; note: string };

const COLUMNS = "id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at";

const now = (): number => Math.floor(Date.now() / 1000);
const newId = (): string => `jb_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;

/** A job id from a URL or a form: plain characters only; anything else is no job. */
export const jobId = (raw: unknown): string | null => (typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(raw) ? raw : null);

/** A job of the branch, or null: another branch's id finds nothing through the fence. */
export async function findJob(sdb: DbStatements, id: unknown): Promise<JobRow | null> {
  const key = jobId(id);
  return key === null ? null : sdb.queryOne<JobRow>(`select ${COLUMNS} from app__jobs where id = ?`, [key]);
}

export interface JobFilter {
  status: string;
  technician: string;
  /** Local `YYYY-MM-DD`: jobs scheduled on that day. */
  day: string;
}

/** The branch's jobs, filtered; `only` limits them to one technician's (a technician's own list). Unscheduled jobs have no day and never match a day filter. */
export async function listJobs(sdb: Db, f: JobFilter, only: string | null): Promise<JobRow[]> {
  const from = f.day === "" ? 0 : Math.floor(Date.parse(`${f.day}T00:00:00Z`) / 1000) - OFFSET_MS / 1000;
  return sdb.query<JobRow>(
    `select ${COLUMNS} from app__jobs where (?1 = '' or status = ?1) and (?2 = '' or technician_user_id = ?2) and (?3 = '' or (scheduled_start >= ?4 and scheduled_start < ?4 + 86400)) and (?5 = '' or technician_user_id = ?5) order by coalesce(scheduled_start, created_at), number limit 300`,
    [f.status, f.technician, f.day, from, only ?? ""],
  );
}

/** The Cedar resource of a job (renox.toml [authz.entities]): `mine` is computed for the signed-in user. */
export const jobResource = (job: Pick<JobRow, "id" | "branch_id" | "status" | "technician_user_id">, userId: string | null) => ({
  type: "Job",
  id: job.id,
  branch_id: job.branch_id,
  status: job.status,
  mine: userId !== null && job.technician_user_id === userId ? "yes" : "no",
});

/** Whether this user may read a job of the branch that is not theirs (the policy decides: a technician may not). */
export async function readsAll(authz: Pick<ActionContext["authz"], "can">, branchId: string): Promise<boolean> {
  return authz.can("job.read", jobResource({ id: "-", branch_id: branchId, status: "new", technician_user_id: null }, null));
}

export async function eventsOf(sdb: DbStatements, job: string): Promise<EventRow[]> {
  return sdb.query<EventRow>("select id, at, by_user_id, from_status, to_status, note from app__job_events where job_id = ? order by id", [job]);
}

export const topicOf = (branchId: string): string => `jobs:${branchId}`;

/** What the actions of this file need of the ctx. */
export interface JobCtx {
  readonly db: DbStatements;
  readonly principal: Principal | null;
  readonly authz: ActionContext["authz"];
  readonly realtime: Pick<Realtime, "publish">;
}

export type Outcome = { ok: true; job: JobRow } | { ok: false; status: 403 | 404 | 409 | 422; message: string };
const fail = (status: 403 | 404 | 409 | 422, message: string): Outcome => ({ ok: false, status, message });

/** The card the board shows for a job. The language of a pushed card is the app's default (it goes to every subscriber). */
export async function cardOf(ctx: Pick<JobCtx, "db">, branch: Branch, sdb: Db, job: JobRow) {
  const customer = await sdb.queryOne<{ name: string }>("select name from app__customers where id = ?", [job.customer_id]);
  const service = await ctx.db.queryOne<{ name_en: string }>("select name_en from app__services where id = ?", [job.service_id]);
  return {
    id: job.id,
    number: job.number,
    status: job.status,
    priority: job.priority,
    customer: customer?.name ?? "",
    service: service?.name_en ?? "",
    technician: job.technician_user_id === null ? "" : await memberName(ctx.db, branch, job.technician_user_id),
    start: job.scheduled_start === null ? "" : `${dayOf(job.scheduled_start)} ${clock(job.scheduled_start)}`,
  };
}

/** Publishes the job's card to the branch's board as out-of-band swaps (partials/job-card.html). */
async function publishCard(ctx: Pick<JobCtx, "db" | "realtime">, branch: Branch, sdb: Db, job: JobRow): Promise<void> {
  await ctx.realtime.publish(topicOf(branch.id), { fragment: "partials/job-card", data: { j: await cardOf(ctx, branch, sdb, job) } });
}

async function record(ctx: Pick<JobCtx, "principal">, sdb: Db, branch: Branch, job: JobRow, from: JobStatus | null, to: JobStatus, note: string): Promise<void> {
  const by = ctx.principal?.id ?? null;
  await sdb.execute("insert into app__job_events (job_id, branch_id, at, by_user_id, from_status, to_status, note) values (?, ?, ?, ?, ?, ?, ?)", [job.id, branch.id, now(), by, from, to, note]);
  await audit.record({ action: "job.transition", actor: { kind: "user", id: by ?? "unknown" }, resource: { type: "Job", id: job.id }, details: { number: job.number, from, to, note } });
}

/**
 * Moves the job to `to` if the table allows it from its current status
 * (otherwise 409), writes the event and the audit record, cancels or releases
 * the booking when the job is cancelled or goes back to `new`, and publishes
 * the card. The job is the active branch's: another branch's is a 404.
 */
export async function transition(ctx: JobCtx & { readonly url?: URL }, id: unknown, to: JobStatus, note: string): Promise<Outcome> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const job = await findJob(sdb, id);
  if (job === null) return fail(404, "Job not found");
  if (!TRANSITIONS[job.status].includes(to)) return fail(409, `A ${job.status.replace("_", " ")} job cannot become ${to.replace("_", " ")}.`);
  // Back to `new` clears the schedule; a cancelled job keeps it, for the history.
  const won = await sdb.execute(
    to === "new"
      ? "update app__jobs set status = 'new', updated_at = ?, booking_id = null, scheduled_start = null, scheduled_end = null where id = ? and status = ?"
      : "update app__jobs set status = ?, updated_at = ? where id = ? and status = ?",
    to === "new" ? [now(), job.id, job.status] : [to, now(), job.id, job.status],
  );
  if (won.changes !== 1) return fail(409, "The job changed meanwhile; reload it.");
  if ((to === "cancelled" || to === "new") && job.booking_id !== null) await cancelVisit(job.booking_id);
  const after = (await findJob(sdb, job.id)) as JobRow;
  await record(ctx, sdb, branch, after, job.status, to, note);
  await publishCard(ctx, branch, sdb, after);
  // The customer hears that the technician is on the way (F7-124).
  if (to === "en_route") {
    const technician = after.technician_user_id === null ? "" : await memberName(ctx.db, branch, after.technician_user_id);
    await notifyCustomer(ctx, { id: after.customer_id }, "technician_on_the_way", { branch_id: branch.id, ref_id: after.id, job_id: after.id, vars: { job: after.number, technician } });
  }
  return { ok: true, job: after };
}

/**
 * Cancels an `invoiced` job because its invoice was credited (lib/invoices.ts):
 * the one way out of `invoiced`, which the table of `TRANSITIONS` does not
 * offer, so a job cannot be cancelled after it was invoiced without a credit
 * note. The event, the audit record and the card are `transition`'s.
 */
export async function cancelInvoiced(ctx: JobCtx, id: unknown, note: string): Promise<Outcome> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const job = await findJob(sdb, id);
  if (job === null) return fail(404, "Job not found");
  if (job.status !== "invoiced") return fail(409, `A ${job.status.replace("_", " ")} job is not cancelled by a credit note.`);
  const won = await sdb.execute("update app__jobs set status = 'cancelled', updated_at = ? where id = ? and status = 'invoiced'", [now(), job.id]);
  if (won.changes !== 1) return fail(409, "The job changed meanwhile; reload it.");
  const after = (await findJob(sdb, job.id)) as JobRow;
  await record(ctx, sdb, branch, after, "invoiced", "cancelled", note);
  await publishCard(ctx, branch, sdb, after);
  return { ok: true, job: after };
}

export interface NewJob {
  site_id: string;
  quote_id: string | null;
  service_id: number;
  priority: Priority;
  description: string;
}

/**
 * Creates a `new` job for a site of the branch (the customer is the site's).
 * With a quotation: it must be the branch's and approved, and have no live job
 * yet (a unique index also enforces it). 422 for an unknown site, quotation or
 * service; 409 for a quotation that is not approved or already has its job.
 */
export async function createJob(ctx: JobCtx, input: NewJob): Promise<Outcome> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const userId = ctx.principal?.id;
  if (userId === undefined) return fail(403, "Forbidden");
  const sdb = scopedDb(ctx.db, branch);
  const site = await sdb.queryOne<{ id: string; customer_id: string }>("select id, customer_id from app__sites where id = ?", [input.site_id]);
  if (site === null) return fail(422, "Choose a site of this branch.");
  const service = await ctx.db.queryOne<{ id: number }>("select id from app__services where id = ? and active = 1 and (branch_id is null or branch_id = ?)", [input.service_id, branch.id]);
  if (service === null) return fail(422, "Unknown service.");
  if (input.quote_id !== null) {
    const quote = await sdb.queryOne<{ status: string; site_id: string }>("select status, site_id from app__quotes where id = ?", [input.quote_id]);
    if (quote === null) return fail(422, "Choose a quotation of this branch.");
    if (quote.status !== "approved") return fail(409, "Only an approved quotation becomes a job.");
    if (quote.site_id !== site.id) return fail(422, "The site is not the quotation's site.");
    const live = await sdb.queryOne<{ number: string }>("select number from app__jobs where quote_id = ? and status != 'cancelled'", [input.quote_id]);
    if (live !== null) return fail(409, `Job ${live.number} already exists for this quotation.`);
  }
  return insertJob(ctx, branch, sdb, { site, serviceId: service.id, quoteId: input.quote_id, priority: input.priority, description: input.description, by: userId, note: input.quote_id === null ? "created" : "created from a quotation" });
}

/**
 * Writes a `new` job (the next company-wide number, the first timeline event,
 * the audit record) and publishes its card. The caller has checked the site,
 * the service and the quotation. `by` is the user the job is made for
 * (`created_by`: who is told about it later); the scheduled job of a contract
 * (lib/contracts.ts) uses the contract's creator and has no principal.
 */
export async function insertJob(
  ctx: Pick<JobCtx, "db" | "principal" | "realtime">,
  branch: Branch,
  sdb: Db,
  j: { site: { id: string; customer_id: string }; serviceId: number; quoteId: string | null; priority: Priority; description: string; by: string; note: string },
): Promise<Outcome & { ok: true }> {
  const id = newId();
  const n = await ctx.db.execute("insert into app__job_numbers (job_id) values (?)", [id]);
  const number = `J-${String(Number(n.lastInsertRowid)).padStart(6, "0")}`;
  const t = now();
  await sdb.execute(
    "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)",
    [id, branch.id, j.site.customer_id, j.site.id, j.quoteId, number, j.priority, j.serviceId, j.description, j.by, t, t],
  );
  const job = (await findJob(sdb, id)) as JobRow;
  await record(ctx, sdb, branch, job, null, "new", j.note);
  await publishCard(ctx, branch, sdb, job);
  return { ok: true, job };
}

const dayLabel = (ms: number): string => `${dayOf(Math.floor(ms / 1000))} ${clock(Math.floor(ms / 1000))}`;

/**
 * Books `technician` at `startMs` for a `new` or `scheduled` job (moving a
 * scheduled one releases its old booking) and makes it `scheduled`. Only a
 * start that `booking` offers is accepted: inside the branch's hours and the
 * technician's free time. A taken start is a 409 naming the next free one.
 */
export async function schedule(ctx: JobCtx, id: unknown, technicianId: string, startMs: number, note = ""): Promise<Outcome> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const job = await findJob(sdb, id);
  if (job === null) return fail(404, "Job not found");
  if (job.status !== "new" && job.status !== "scheduled") return fail(409, `A ${job.status.replace("_", " ")} job cannot be scheduled.`);
  const technicians = await techniciansOf(ctx, branch);
  const tech = technicians.find((t) => t.id === technicianId);
  if (tech === undefined) return fail(422, "Choose a technician of this branch.");
  const service = await ctx.db.queryOne<{ code: string }>("select code from app__services where id = ?", [job.service_id]);
  if (service === null) return fail(422, "Unknown service.");
  await ensureSynced(ctx.db, branch, [tech], service.code);
  const code = bookingService(service.code);
  if (!Number.isSafeInteger(startMs)) return fail(422, "Choose a start.");
  const free = (await slotsOn(code, dayOf(Math.floor(startMs / 1000)), [tech.id])).find((s) => s.start === startMs);
  const taken = async (): Promise<Outcome> => {
    const next = await nextFree(code, tech.id, Math.max(startMs, Date.now()));
    return fail(409, `${tech.name} is not free at ${dayLabel(startMs)}; ${next === null ? "there is no free slot in the next two weeks." : `the next free slot is ${dayLabel(next.start)}.`}`);
  };
  if (free === undefined) return taken();
  let bookingId: string;
  try {
    bookingId = await bookVisit(code, tech.id, startMs, job.customer_id);
  } catch (e) {
    if (isTaken(e)) return taken();
    throw e;
  }
  if (job.booking_id !== null) await cancelVisit(job.booking_id);
  const moved = job.status === "scheduled";
  await sdb.execute("update app__jobs set status = 'scheduled', technician_user_id = ?, booking_id = ?, scheduled_start = ?, scheduled_end = ?, updated_at = ? where id = ?", [
    tech.id,
    bookingId,
    Math.floor(free.start / 1000),
    Math.floor(free.end / 1000),
    now(),
    job.id,
  ]);
  const after = (await findJob(sdb, job.id)) as JobRow;
  await record(ctx, sdb, branch, after, job.status, "scheduled", `${moved ? "moved to" : "scheduled for"} ${dayLabel(startMs)} with ${tech.name}${note === "" ? "" : `: ${note}`}`);
  await publishCard(ctx, branch, sdb, after);
  // The customer hears the time (a move too), in the language of their file (F7-124).
  await notifyCustomer(ctx, { id: after.customer_id }, "visit_scheduled", { branch_id: branch.id, ref_id: after.id, job_id: after.id, vars: { job: after.number, when: dayLabel(startMs), technician: tech.name } });
  return { ok: true, job: after };
}

/**
 * Gives the job to a technician. A scheduled job keeps its time: the new
 * technician must be free then (the old booking is released). An unscheduled
 * one only records the technician, whom the slot picker then offers first.
 */
export async function assign(ctx: JobCtx, id: unknown, technicianId: string): Promise<Outcome> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const job = await findJob(sdb, id);
  if (job === null) return fail(404, "Job not found");
  if (job.status === "scheduled" && job.scheduled_start !== null) return schedule(ctx, id, technicianId, job.scheduled_start * 1000, "reassigned");
  if (job.status !== "new") return fail(409, `A ${job.status.replace("_", " ")} job cannot be reassigned.`);
  const tech = (await techniciansOf(ctx, branch)).find((t) => t.id === technicianId);
  if (tech === undefined) return fail(422, "Choose a technician of this branch.");
  await sdb.execute("update app__jobs set technician_user_id = ?, updated_at = ? where id = ?", [tech.id, now(), job.id]);
  const after = (await findJob(sdb, job.id)) as JobRow;
  await record(ctx, sdb, branch, after, "new", "new", `assigned to ${tech.name}`);
  await publishCard(ctx, branch, sdb, after);
  return { ok: true, job: after };
}
