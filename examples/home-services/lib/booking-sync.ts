// The app's side of the `booking` module: the catalogue as booking services,
// the branch's technicians as booking staff with the branch's working hours,
// slot search per technician, and one booking per scheduled visit.
//
// `booking` is global (its services and staff belong to the company, not to a
// branch) and its catalogue calls need the manage permission of that module (policies/app/base.cedar
// grants it to the people who dispatch). Slots are searched per technician of
// the branch, so another branch's staff never appear. A service's length is on
// this side: the catalogue prices a visit, an hour or a unit, not a duration.
import type { Authz, DbStatements } from "@renoxium/sdk";
import { booking } from "renox:modules";

import { day as dayOf } from "./quotes";
import type { Branch } from "./scope";
import { techniciansOf, type Technician } from "./technicians";

/** The app's offset from UTC in milliseconds (Asia/Dubai, no daylight saving). */
export const OFFSET_MS = 4 * 3_600_000;

/** Minutes a visit takes, by booking service id; any other service takes DEFAULT_MINUTES. */
const MINUTES: Record<string, number> = { "ac-service": 60, "ac-repair": 90, "deep-clean": 180, pest: 90, plumbing: 90, electrical: 90, handyman: 60, "amc-visit": 60 };
const DEFAULT_MINUTES = 60;

/** Mon to Thu and Sat 08:00 to 18:00, Friday 14:00 to 18:00, Sunday closed (weekday 0 is Sunday): for a branch with no rows in app__branch_hours. */
export const DEFAULT_HOURS: readonly { weekday: number; open_min: number; close_min: number }[] = [
  { weekday: 1, open_min: 480, close_min: 1080 },
  { weekday: 2, open_min: 480, close_min: 1080 },
  { weekday: 3, open_min: 480, close_min: 1080 },
  { weekday: 4, open_min: 480, close_min: 1080 },
  { weekday: 5, open_min: 840, close_min: 1080 },
  { weekday: 6, open_min: 480, close_min: 1080 },
];

/** Display order of the week (Monday first); storage keeps weekday 0 = Sunday. */
export const WEEK_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

export type HourRow = { weekday: number; open_min: number; close_min: number };

/** The branch's weekly hours: its rows of app__branch_hours (a closed weekday has none), or the standard hours when it has no rows at all. */
export async function hoursOf(db: DbStatements, branchId: string): Promise<HourRow[]> {
  const rows = await db.query<HourRow>("select weekday, open_min, close_min from app__branch_hours where branch_id = ? order by weekday", [branchId]);
  return rows.length > 0 ? rows : DEFAULT_HOURS.map((h) => ({ ...h }));
}

/** Whether a job that runs from `start` to `end` (unix seconds, null: one hour) falls outside `hours` (local time, UTC+4). */
export function outsideHours(start: number, end: number | null, hours: readonly HourRow[]): boolean {
  const local = new Date(start * 1000 + OFFSET_MS);
  const open = hours.find((h) => h.weekday === local.getUTCDay());
  if (open === undefined) return true;
  const from = local.getUTCHours() * 60 + local.getUTCMinutes();
  const to = from + Math.ceil(((end ?? start + 3600) - start) / 60);
  return from < open.open_min || to > open.close_min;
}

/** The jobs of the branch still to come (status `scheduled`, from `nowSeconds` on) that fall outside its current hours. `sdb` is fenced to the branch. */
export async function jobsOutsideHours(db: DbStatements, sdb: DbStatements, branchId: string, nowSeconds: number): Promise<string[]> {
  const hours = await hoursOf(db, branchId);
  const jobs = await sdb.query<{ id: string; scheduled_start: number; scheduled_end: number | null }>("select id, scheduled_start, scheduled_end from app__jobs where branch_id = ? and status = 'scheduled' and scheduled_start is not null and scheduled_start >= ? order by scheduled_start, id", [branchId, nowSeconds]);
  return jobs.filter((j) => outsideHours(j.scheduled_start, j.scheduled_end, hours)).map((j) => j.id);
}

/**
 * After app__branch_hours changed: hands the new hours to `booking` for each technician (`ensureSynced` sets the
 * weekdays that have a row) and deletes the weekdays that have none (closed), so the slots follow at once.
 */
export async function syncHours(db: DbStatements, branch: Branch, technicians: readonly Technician[]): Promise<void> {
  await ensureSynced(db, branch, technicians);
  const open = new Set((await hoursOf(db, branch.id)).map((h) => h.weekday));
  for (const t of technicians) for (const wd of WEEK_ORDER) if (!open.has(wd)) await booking.setHours(t.id, wd, null, null);
}

export type Slot = { start: number; end: number; staff: string };

/** The booking service id of a catalogue code (booking ids are lower case). */
export const bookingService = (code: string): string => code.toLowerCase();

/** What this request already handed to `booking`, by the request's Db: once per request is enough (a module call costs CPU time, and a page or a tool call has a small budget). */
const done = new WeakMap<object, Set<string>>();

/**
 * Hands the catalogue and the branch's technicians (with the branch's hours) to
 * `booking`. Nothing is recorded on this side: addService and addStaff are
 * upserts and setHours replaces a weekday's row (booking 1.0.1), so every
 * request may repeat it and the result is the same. A caller hands over what it
 * is about to use: the `serviceCode` it will search or book (default: the whole
 * catalogue) and the technicians it passes; each call only adds to what
 * `booking` holds. Within one request the same part is handed over once.
 */
export async function ensureSynced(db: DbStatements, branch: Branch, technicians: readonly Technician[], serviceCode?: string): Promise<void> {
  const seen = done.get(db) ?? new Set<string>();
  done.set(db, seen);
  const all = await db.query<{ code: string; name_en: string }>("select code, name_en from app__services where active = 1 order by id", []);
  const services = serviceCode === undefined ? all : all.filter((s) => bookingService(s.code) === bookingService(serviceCode));
  const ids: string[] = [];
  for (const s of services) {
    const id = bookingService(s.code);
    ids.push(id);
    if (seen.has(`service:${id}`)) continue;
    seen.add(`service:${id}`);
    await booking.addService({ id, name: s.name_en, minutes: MINUTES[id] ?? DEFAULT_MINUTES, deposit_fils: 0 });
  }
  const rows = await db.query<{ weekday: number; open_min: number; close_min: number }>("select weekday, open_min, close_min from app__branch_hours where branch_id = ? order by weekday", [branch.id]);
  const hours = rows.length > 0 ? rows : DEFAULT_HOURS;
  for (const t of technicians) {
    const key = `staff:${t.id}:${ids.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await booking.addStaff({ id: t.id, name: t.name, user_id: t.id, services: ids });
    if (seen.has(`hours:${t.id}`)) continue;
    seen.add(`hours:${t.id}`);
    for (const h of hours) await booking.setHours(t.id, h.weekday, h.open_min, h.close_min);
  }
}

/** The free slots of `service` on `day` (YYYY-MM-DD) for these technicians, earliest first. */
export async function slotsOn(service: string, dayKey: string, staff: readonly string[]): Promise<Slot[]> {
  const out: Slot[] = [];
  for (const id of staff) out.push(...(await booking.slots(service, dayKey, { staff: id })));
  return out.sort((a, b) => a.start - b.start || a.staff.localeCompare(b.staff));
}

/** The first free slot of `staff` from `fromMs` on, looking up to `days` days ahead; null when there is none. */
export async function nextFree(service: string, staff: string, fromMs: number, days = 14): Promise<Slot | null> {
  for (let i = 0; i < days; i++) {
    const key = dayOf(Math.floor((fromMs + i * 86_400_000) / 1000));
    const free = (await booking.slots(service, key, { staff })).filter((s) => s.start >= fromMs);
    if (free[0] !== undefined) return free[0];
  }
  return null;
}

/** What booking answers when a start is taken or outside the hours (its BookingError "TAKEN"). */
export const isTaken = (e: unknown): boolean => /taken|outside the hours/u.test((e as { message?: string }).message ?? "") || (e as { code?: string }).code === "TAKEN";

/** Holds and confirms a visit; throws what `booking` throws (see isTaken). Returns the booking's id. */
export async function bookVisit(service: string, staff: string, startMs: number, customer: string): Promise<string> {
  const held = await booking.hold(service, staff, startMs, customer);
  await booking.confirm(held.id);
  return held.id;
}

export async function cancelVisit(bookingId: string): Promise<void> {
  await booking.cancel(bookingId);
}

/** The local time of a unix-seconds instant as `HH:MM`. */
export const clock = (seconds: number): string => new Date(seconds * 1000 + OFFSET_MS).toISOString().slice(11, 16);

/** What `syncCatalogue` reads: the request's Db and the roles (the technicians are the holders of the `technician` role). */
interface SyncCtx {
  readonly authz: Pick<Authz, "roles">;
  readonly db: DbStatements;
}

/**
 * Mirrors what `/book` offers into `booking`: the active services, the technicians of the branch
 * (`branchId`; default every branch) and the branch's working hours, closed weekdays included. Idempotent
 * (ensureSynced and syncHours only upsert), and a call always repeats the hand-over, even when this request did
 * it before: the caller has just changed something. Every action that changes the catalogue calls it (a service
 * saved, a technician's role, a branch's hours) and so does `shell()` for a pending sync. It needs
 * `booking.manage`: a caller without it (an event handler, a job, the setup route: `System::"app"` or no
 * principal) calls `markSyncPending` instead.
 */
export async function syncCatalogue(ctx: SyncCtx, branchId?: string): Promise<void> {
  done.delete(ctx.db);
  const branches = await ctx.db.query<Branch>("select id, org_id, name_en, name_ar, slug, emirate, area from app__branches where (? is null or id = ?) order by id", [branchId ?? null, branchId ?? null]);
  for (const branch of branches) await syncHours(ctx.db, branch, await techniciansOf(ctx, branch));
}

/** The settings key that says a sync is still to be made: set by a caller that cannot sync, cleared by `shell()`. */
export const SYNC_PENDING = "booking_sync_pending";

/** Records that `/book` may offer something `booking` does not hold yet; the next request of a person who holds `booking.manage` syncs (lib/page.ts). */
export async function markSyncPending(db: DbStatements): Promise<void> {
  await db.execute("insert into app__settings (key, value) values (?, '1') on conflict (key) do update set value = excluded.value", [SYNC_PENDING]);
}
