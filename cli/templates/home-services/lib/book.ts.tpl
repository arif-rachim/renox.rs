// Self-booking (#775): the public page /book and its confirmation
// /book/confirm/<draft>. A visitor picks a service and the place (step 1),
// a time (step 2) and gives a name and a WhatsApp number (step 3); that holds
// the slot in `booking` and stores a draft (app__booking_drafts) that lives
// as long as the hold. Their WhatsApp code signs them in (auth's phone pages),
// and the confirmation turns the draft into a job of the branch that serves
// the emirate: the customer and the site are found or made for their phone
// (lib/customer-db.ts bookingCustomer, on the branch's fenced database), the
// job is `new` with the requested time (the dispatcher confirms) or, with the
// setting `portal_auto_confirm`, `scheduled` with the technician at once.
//
// Steps 1 and 2 are plain GET forms: the choices travel in the query string,
// and the app writes nothing and sets no cookie of its own before step 3.
// What the anonymous page may not do: hand the catalogue to `booking` (that
// is `booking.manage`, lib/booking-sync.ts ensureSynced); it searches the
// slots `booking` already holds for the branch's technicians.
import type { Authz, DbStatements, Principal, Realtime } from "@renoxium/sdk";
import { booking, gcc } from "renox:modules";

import { bookingService, clock, OFFSET_MS, slotsOn } from "./booking-sync";
import { bookingCustomer } from "./customer-db";
import { EMIRATES } from "./forms";
import { insertJob } from "./jobs";
import { notifyCustomer, notifyStaff } from "./notify";
import { day as dayOf } from "./quotes";
import { branchDb, findBranch, type Branch, type Scopable } from "./scope";
import { getSettings, portalAutoConfirm } from "./settings";
import { memberName, techniciansOf } from "./technicians";

/** How many days step 2 offers, from today; how many slots of a day it shows. */
export const DAYS = 7;
export const MAX_SLOTS = 12;
/** Drafts per client address per hour, and live (unconfirmed) drafts per phone. */
export const IP_LIMIT = 5;
export const PHONE_LIMIT = 3;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A branch row spells its emirate as the setup call does (`AE-DU`) or as the back office does (`dubai`): both are the same emirate. */
const BRANCH_EMIRATE: Record<(typeof EMIRATES)[number], string> = {
  "AE-AZ": "abu_dhabi",
  "AE-DU": "dubai",
  "AE-SH": "sharjah",
  "AE-AJ": "ajman",
  "AE-UQ": "umm_al_quwain",
  "AE-RK": "ras_al_khaimah",
  "AE-FU": "fujairah",
};

/** What the visitor chose so far, as typed (trimmed, cut at their limit + 1 so an over-long value fails it). */
export interface Choices {
  service: string;
  emirate: string;
  area: string;
  address: string;
  makani: string;
  notes: string;
  day: string;
  slot: string;
}

const CHOICE_LIMITS: Record<keyof Choices, number> = { service: 12, emirate: 10, area: 80, address: 200, makani: 20, notes: 500, day: 10, slot: 90 };

export function choicesOf(source: { get(name: string): unknown }): Choices {
  const out = {} as Choices;
  for (const [k, max] of Object.entries(CHOICE_LIMITS) as [keyof Choices, number][]) {
    const v = source.get(k);
    out[k] = typeof v === "string" ? v.trim().slice(0, max + 1) : "";
  }
  return out;
}

/** The query string that carries `c` (and `extra`) to another step. */
export function queryOf(c: Partial<Choices>, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...c, ...extra })) if (typeof v === "string" && v !== "") q.set(k, v);
  return q.toString();
}

export type BookService = { id: number; code: string; name_en: string; name_ar: string; unit: string; price_fils: number; branch_id: string | null };

/** The services offered on /book: active, with self-booking on. app__services is not owned (branch_id null: every branch). */
export async function bookableServices(db: DbStatements): Promise<BookService[]> {
  return db.query<BookService>("select id, code, name_en, name_ar, unit, price_fils, branch_id from app__services where active = 1 and self_booking = 1 order by id", []);
}

export type Area = { name_en: string; name_ar: string };

/** The gcc module's areas of an emirate code (empty for anything else). */
export async function areasOf(emirate: string): Promise<Area[]> {
  if (!(EMIRATES as readonly string[]).includes(emirate)) return [];
  return (await gcc.listAreas(emirate)) as Area[];
}

export interface Place {
  service: BookService;
  emirate: string;
  area: string;
  address: string;
  makani: string | null;
  notes: string;
}

/** Step 1's checks: the field to i18n key map of what is wrong, or the place. */
export async function checkPlace(db: DbStatements, c: Choices): Promise<{ value: Place } | { errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const id = Number(c.service);
  const service = Number.isSafeInteger(id) && id > 0 ? ((await bookableServices(db)).find((s) => s.id === id) ?? null) : null;
  if (service === null) errors.service = "book.err.service";
  const areas = await areasOf(c.emirate);
  if (areas.length === 0) errors.emirate = "book.err.emirate";
  else if (!areas.some((a) => a.name_en === c.area)) errors.area = "book.err.area";
  if (c.address.length < 5 || c.address.length > 200) errors.address = "book.err.address";
  let makani: string | null = null;
  if (c.makani !== "") {
    const m = (await gcc.validateMakani(c.makani)) as { ok: boolean; value?: string };
    if (m.ok && typeof m.value === "string") makani = m.value;
    else errors.makani = "book.err.makani";
  }
  if (c.notes.length > 500) errors.notes = "book.err.notes";
  if (Object.keys(errors).length > 0 || service === null) return { errors };
  return { value: { service, emirate: c.emirate, area: c.area, address: c.address, makani, notes: c.notes } };
}

/** The branch that serves the emirate: the first by name of those whose emirate is it (every branch row is an active branch). */
export async function branchFor(db: DbStatements, emirate: string): Promise<Branch | null> {
  const other = BRANCH_EMIRATE[emirate as (typeof EMIRATES)[number]];
  if (other === undefined) return null;
  return db.queryOne<Branch>("select id, org_id, name_en, name_ar, slug, emirate, area from app__branches where emirate in (?, ?) order by name_en, id limit 1", [emirate, other]);
}

/** The phone a visitor whose emirate has no branch may call: the company's, else the first branch's. */
export async function companyPhone(db: DbStatements): Promise<string> {
  const set = ((await getSettings(db)).company_phone ?? "").trim();
  if (set !== "") return set;
  return (await db.queryOne<{ phone: string }>("select phone from app__branches where phone != '' order by name_en, id limit 1", []))?.phone ?? "";
}

/** The next DAYS days (Dubai), from today: the key and the weekday (0 is Sunday). */
export function nextDays(fromMs = Date.now()): { key: string; weekday: number }[] {
  const out: { key: string; weekday: number }[] = [];
  for (let i = 0; i < DAYS; i++) {
    const ms = fromMs + i * 86_400_000;
    out.push({ key: dayOf(Math.floor(ms / 1000)), weekday: new Date(ms + OFFSET_MS).getUTCDay() });
  }
  return out;
}

export type FreeSlot = { value: string; staff: string; start: number; end: number; from: string; to: string };

/** The value of a slot in a form: `<technician id>@<start in unix ms>`. */
export const slotValue = (staff: string, startMs: number): string => `${staff}@${startMs}`;

export function parseSlot(value: string): { staff: string; start: number } | null {
  const m = /^([A-Za-z0-9_-]{1,64})@(\d{12,15})$/u.exec(value);
  return m === null ? null : { staff: m[1] as string, start: Number(m[2]) };
}

interface SlotCtx {
  readonly db: DbStatements;
  readonly authz: Pick<Authz, "roles">;
}

/** The jobs each technician has on `dayKey` (Dubai), cancelled ones left out: the load that decides who takes a time several are free at. */
async function loadOn(db: DbStatements, dayKey: string): Promise<Map<string, number>> {
  const from = Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / 1000) - OFFSET_MS / 1000;
  const rows = await db.query<{ technician_user_id: string; n: number }>(
    "select technician_user_id, count(*) as n from app__jobs where technician_user_id is not null and status != 'cancelled' and scheduled_start >= ? and scheduled_start < ? group by technician_user_id",
    [from, from + 86_400],
  );
  return new Map(rows.map((r) => [r.technician_user_id, r.n]));
}

/**
 * The free slots of `dayKey`, from now on, grouped by time: for each (start,
 * end) the technicians free then, the least loaded first (ties: the id), and
 * the first MAX_SLOTS distinct times, earliest first. A service or technician
 * `booking` does not know yet offers nothing.
 */
async function freeTimes(ctx: SlotCtx, branch: Branch, service: Pick<BookService, "code">, dayKey: string): Promise<FreeSlot[][]> {
  const staff = (await techniciansOf(ctx, branch)).map((t) => t.id);
  if (staff.length === 0) return [];
  let found: { start: number; end: number; staff: string }[];
  try {
    found = await slotsOn(bookingService(service.code), dayKey, staff);
  } catch (e) {
    if ((e as { code?: string }).code === "NOT_FOUND" || /no such service/u.test((e as { message?: string }).message ?? "")) return [];
    throw e;
  }
  const now = Date.now();
  const load = await loadOn(ctx.db, dayKey);
  const times = new Map<string, FreeSlot[]>();
  for (const s of found) {
    if (s.start < now) continue;
    const slot: FreeSlot = { value: slotValue(s.staff, s.start), staff: s.staff, start: s.start, end: s.end, from: clock(Math.floor(s.start / 1000)), to: clock(Math.floor(s.end / 1000)) };
    const key = `${s.start}-${s.end}`;
    times.set(key, [...(times.get(key) ?? []), slot]);
  }
  return [...times.values()]
    .map((group) => group.sort((a, b) => (load.get(a.staff) ?? 0) - (load.get(b.staff) ?? 0) || a.staff.localeCompare(b.staff)))
    .sort((a, b) => (a[0] as FreeSlot).start - (b[0] as FreeSlot).start || (a[0] as FreeSlot).end - (b[0] as FreeSlot).end)
    .slice(0, MAX_SLOTS);
}

/**
 * The free times of `service` on `dayKey` across the branch's technicians
 * (the search of the next_free_slot tool, lib/tools.ts nextFreeSlots), from
 * now on, earliest first, each time once with the technician who has the
 * fewest jobs that day, at most MAX_SLOTS distinct times.
 */
export async function freeSlots(ctx: SlotCtx, branch: Branch, service: Pick<BookService, "code">, dayKey: string): Promise<FreeSlot[]> {
  return (await freeTimes(ctx, branch, service, dayKey)).map((g) => g[0] as FreeSlot);
}

/**
 * The slot a submitted `value` stands for: the same time, with the chosen
 * technician if still free, else silently another technician free then (the
 * visitor chose a time, not a person). Undefined when the time is not one the
 * page offers now or nobody is free at it ("That time was just taken").
 */
export async function resolveSlot(ctx: SlotCtx, branch: Branch, service: Pick<BookService, "code">, value: string): Promise<FreeSlot | undefined> {
  const parsed = parseSlot(value);
  if (parsed === null) return undefined;
  const group = (await freeTimes(ctx, branch, service, dayOf(Math.floor(parsed.start / 1000)))).find((g) => (g[0] as FreeSlot).start === parsed.start);
  return group?.find((s) => s.staff === parsed.staff) ?? group?.[0];
}

/** The client address as the platform passes it (auth's `clientIp`), hashed: the app never stores the address. */
export async function ipHashOf(headers: Headers): Promise<string> {
  const ip = headers.get("x-renox-client-ip") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`book|${ip}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Which limit a new draft would pass: 5 an hour per address, 3 live drafts per phone; null when neither. */
export async function overLimit(db: DbStatements, ipHash: string, phone: string): Promise<"ip" | "phone" | null> {
  const now = nowSeconds();
  const byIp = await db.queryOne<{ n: number }>("select count(*) as n from app__booking_draft_log where ip_hash = ? and created_at > ?", [ipHash, now - 3600]);
  if ((byIp?.n ?? 0) >= IP_LIMIT) return "ip";
  const byPhone = await db.queryOne<{ n: number }>("select count(*) as n from app__booking_drafts where phone = ? and expires_at > ?", [phone, now]);
  if ((byPhone?.n ?? 0) >= PHONE_LIMIT) return "phone";
  return null;
}

export type DraftRow = {
  id: string;
  service_id: number;
  emirate: string;
  area: string;
  address: string;
  makani: string | null;
  slot_start: number;
  slot_end: number;
  technician_user_id: string;
  branch_id: string;
  hold_id: string | null;
  name: string;
  phone: string;
  language: string;
  notes: string;
  created_at: number;
  expires_at: number;
};

/** A draft id from a URL: `bd_` and 32 hex characters; anything else is no draft. */
export const draftId = (raw: unknown): string | null => (typeof raw === "string" && /^bd_[0-9a-f]{32}$/u.test(raw) ? raw : null);

export async function findDraft(db: DbStatements, id: unknown): Promise<DraftRow | null> {
  const key = draftId(id);
  return key === null ? null : db.queryOne<DraftRow>("select id, service_id, emirate, area, address, makani, slot_start, slot_end, technician_user_id, branch_id, hold_id, name, phone, language, notes, created_at, expires_at from app__booking_drafts where id = ?", [key]);
}

export interface NewDraft {
  place: Place;
  branch: Branch;
  slot: FreeSlot;
  name: string;
  phone: string;
  language: "en" | "ar";
  ipHash: string;
}

/**
 * Holds the slot in `booking` (its `hold_minutes`) and stores the draft, which
 * expires with the hold. A slot taken since the page was shown is "taken"
 * (booking's TAKEN), and nothing is stored.
 */
export async function createDraft(db: DbStatements, d: NewDraft): Promise<{ id: string } | "taken"> {
  const id = `bd_${crypto.randomUUID().replace(/-/gu, "")}`;
  let held: { id: string; expires_at: number };
  try {
    held = (await booking.hold(bookingService(d.place.service.code), d.slot.staff, d.slot.start, id)) as { id: string; expires_at: number };
  } catch (e) {
    if (/taken|outside the hours/u.test((e as { message?: string }).message ?? "") || (e as { code?: string }).code === "TAKEN") return "taken";
    throw e;
  }
  const now = nowSeconds();
  await db.execute("insert into app__booking_drafts (id, service_id, emirate, area, address, makani, slot_start, slot_end, technician_user_id, branch_id, hold_id, name, phone, language, notes, created_at, expires_at, ip_hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    id,
    d.place.service.id,
    d.place.emirate,
    d.place.area,
    d.place.address,
    d.place.makani,
    Math.floor(d.slot.start / 1000),
    Math.floor(d.slot.end / 1000),
    d.slot.staff,
    d.branch.id,
    held.id,
    d.name,
    d.phone,
    d.language,
    d.place.notes,
    now,
    Math.floor(held.expires_at / 1000),
    d.ipHash,
  ]);
  await db.execute("insert into app__booking_draft_log (ip_hash, created_at) values (?, ?)", [d.ipHash, now]);
  return { id };
}

/** The query string of step 2 for a draft's choices: where an expired hold sends the visitor back. */
export const step2Of = (d: DraftRow): string =>
  queryOf({ service: String(d.service_id), emirate: d.emirate, area: d.area, address: d.address, makani: d.makani ?? "", notes: d.notes, day: dayOf(d.slot_start) }, { step: "2", taken: "1" });

/** The members of the branch's organisation who hold the `dispatcher` role (global, or for that branch). */
export async function dispatchersOf(ctx: SlotCtx, branch: Branch): Promise<string[]> {
  const members = await ctx.db.query<{ user_id: string }>("select user_id from org__public_members_v1 where org_id = ? order by user_id", [branch.org_id]);
  const out: string[] = [];
  for (const m of members) {
    const roles = await ctx.authz.roles.list(m.user_id);
    if (roles.some((r) => r.role === "dispatcher" && (r.scope_type === "global" || r.scope_id === branch.org_id))) out.push(m.user_id);
  }
  return out;
}

export interface ConfirmCtx {
  readonly db: Scopable;
  readonly principal: Principal | null;
  readonly authz: Pick<Authz, "roles">;
  readonly realtime: Pick<Realtime, "publish">;
  readonly url?: URL;
}

const when = (seconds: number): string => `${dayOf(seconds)} ${clock(seconds)}`;

/**
 * Turns the draft into a job, in the caller's transaction (the confirm
 * action's): the customer and the site for the user's phone in the draft's
 * branch, the job (`source = self_booking`), the hold confirmed (auto-confirm:
 * the job is `scheduled` with the technician) or released (the job is `new`,
 * with the requested time and no technician), the customer's WhatsApp, the
 * branch's dispatchers told in the app, and the draft deleted. An expired
 * draft, or one whose branch or service is gone, is "taken" and nothing is
 * written. The caller checked that the draft is the user's.
 */
export async function confirmDraft(ctx: ConfirmCtx, user: { user_id: string; phone: string }, d: DraftRow): Promise<{ job_id: string; number: string } | "taken"> {
  if (d.expires_at <= nowSeconds() || d.hold_id === null) return "taken";
  const branch = await findBranch(ctx.db, d.branch_id);
  const service = await ctx.db.queryOne<{ id: number; code: string }>("select id, code from app__services where id = ? and active = 1", [d.service_id]);
  if (branch === null || service === null) return "taken";
  const auto = portalAutoConfirm(await getSettings(ctx.db));
  // The booking first: nothing of the app is written before it answers.
  if (auto) await booking.confirm(d.hold_id);
  else await booking.cancel(d.hold_id);
  const language = d.language === "ar" ? "ar" : "en";
  const place = await bookingCustomer(ctx.db, branch.id, user.user_id, { name: d.name, phone: user.phone, language, emirate: d.emirate, area: d.area, address: d.address, makani: d.makani });
  const sdb = branchDb(ctx.db, branch.id);
  const technician = auto ? await memberName(ctx.db, branch, d.technician_user_id) : "";
  const made = await insertJob(ctx, branch, sdb, {
    site: { id: place.site_id, customer_id: place.customer_id },
    serviceId: service.id,
    quoteId: null,
    priority: "normal",
    description: d.notes,
    by: user.user_id,
    note: auto ? `self-booked for ${when(d.slot_start)} with ${technician}, confirmed at once` : `self-booked: requested ${when(d.slot_start)}, waiting for the dispatcher`,
    source: "self_booking",
    slot: { start: d.slot_start, end: d.slot_end, technician: auto ? d.technician_user_id : null, booking_id: auto ? d.hold_id : null },
  });
  const job = made.job;
  if (auto) await notifyCustomer(ctx, { id: place.customer_id }, "visit_scheduled", { branch_id: branch.id, ref_id: job.id, job_id: job.id, vars: { job: job.number, when: when(d.slot_start), technician } });
  else await notifyCustomer(ctx, { id: place.customer_id }, "booking_received", { branch_id: branch.id, ref_id: job.id, job_id: job.id, vars: { job: job.number, when: when(d.slot_start) } });
  await notifyStaff(await dispatchersOf(ctx, branch), { category: "jobs", title: `New self-booking ${job.number}`, link: `/jobs/${job.id}` });
  await ctx.db.execute("delete from app__booking_drafts where id = ?", [d.id]);
  return { job_id: job.id, number: job.number };
}

/**
 * The sweep of jobs/booking-drafts.ts: every expired draft's hold is released
 * (booking.cancel of a hold that is still `held`) and the draft deleted; the
 * address log keeps a day. Returns how many drafts went.
 */
export async function sweepDrafts(ctx: { readonly db: DbStatements }): Promise<number> {
  const now = nowSeconds();
  const due = await ctx.db.query<{ id: string; hold_id: string | null }>("select id, hold_id from app__booking_drafts where expires_at <= ? order by expires_at, id limit 500", [now]);
  for (const d of due) {
    if (d.hold_id !== null) await booking.cancel(d.hold_id);
    await ctx.db.execute("delete from app__booking_drafts where id = ?", [d.id]);
  }
  await ctx.db.execute("delete from app__booking_draft_log where created_at < ?", [now - 86_400]);
  return due.length;
}
