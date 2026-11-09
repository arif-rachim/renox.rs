// The app's side of the `booking` module: the catalogue as booking services,
// the branch's technicians as booking staff with the branch's working hours,
// slot search per technician, and one booking per scheduled visit.
//
// `booking` is global (its services and staff belong to the company, not to a
// branch) and its catalogue calls need the manage permission of that module (policies/app/base.cedar
// grants it to the people who dispatch). Slots are searched per technician of
// the branch, so another branch's staff never appear. A service's length is on
// this side: the catalogue prices a visit, an hour or a unit, not a duration.
import type { DbStatements } from "@renoxium/sdk";
import { booking } from "renox:modules";

import { day as dayOf } from "./quotes";
import type { Branch } from "./scope";
import type { Technician } from "./technicians";

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

export type Slot = { start: number; end: number; staff: string };

/** The booking service id of a catalogue code (booking ids are lower case). */
export const bookingService = (code: string): string => code.toLowerCase();

const now = (): number => Math.floor(Date.now() / 1000);

async function mark(db: DbStatements, key: string): Promise<boolean> {
  return (await db.execute("insert into app__booking_sync (key, at) values (?, ?) on conflict do nothing", [key, now()])).changes === 1;
}

/**
 * Hands the catalogue to `booking` the first time a branch needs it, and each
 * technician (with the branch's hours) the first time they are seen. Both are
 * recorded in app__booking_sync, because setHours adds a row at every call.
 */
export async function ensureSynced(db: DbStatements, branch: Branch, technicians: readonly Technician[]): Promise<void> {
  const services = await db.query<{ code: string; name_en: string }>("select code, name_en from app__services where active = 1 order by id", []);
  if (await mark(db, `catalogue:${branch.id}`)) {
    for (const s of services) await booking.addService({ id: bookingService(s.code), name: s.name_en, minutes: MINUTES[bookingService(s.code)] ?? DEFAULT_MINUTES, deposit_fils: 0 });
  }
  const rows = await db.query<{ weekday: number; open_min: number; close_min: number }>("select weekday, open_min, close_min from app__branch_hours where branch_id = ? order by weekday", [branch.id]);
  const hours = rows.length > 0 ? rows : DEFAULT_HOURS;
  for (const t of technicians) {
    if (!(await mark(db, `staff:${t.id}`))) continue;
    await booking.addStaff({ id: t.id, name: t.name, user_id: t.id, services: services.map((s) => bookingService(s.code)) });
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
