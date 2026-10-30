// The booking module (#334): slot search over weekly and dated hours, the
// service's length and buffer, and the staff's live bookings (held ones
// until they expire). Pure functions do the arithmetic; the services read
// and write the module's tables.

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface BookingCtx {
  db: Db;
  config: { slot_minutes?: number; hold_minutes?: number };
  events: { emit(name: string, payload: unknown): Promise<void> };
  /** The app's offset from UTC in minutes (Asia/Dubai: 240). */
  utcOffsetMinutes?: number;
}

export class BookingError extends Error {
  constructor(message: string, readonly code: "INVALID" | "TAKEN" | "NOT_FOUND") {
    super(message);
    this.name = "BookingError";
  }
}

export interface Window {
  open: number;
  close: number;
}
export interface Busy {
  start: number;
  end: number;
}

/**
 * Slots of `minutes` (+ `buffer` after) starting on the `grid` within the
 * windows (ms), never overlapping a busy interval, never before `notBefore`.
 */
export function freeSlots(windows: readonly Window[], busy: readonly Busy[], minutes: number, buffer: number, grid: number, notBefore = 0): Busy[] {
  const len = minutes * 60_000;
  const pad = buffer * 60_000;
  const step = grid * 60_000;
  const out: Busy[] = [];
  for (const w of windows) {
    for (let t = Math.ceil(w.open / step) * step; t + len <= w.close; t += step) {
      if (t < notBefore) continue;
      const end = t + len;
      if (busy.some((b) => t < b.end + pad && end + pad > b.start)) continue;
      out.push({ start: t, end });
    }
  }
  return out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** The UTC ms of local midnight of `day` for an offset. */
export function midnight(day: string, offsetMinutes: number): number {
  if (!DAY.test(day)) throw new BookingError("day: YYYY-MM-DD", "INVALID");
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - offsetMinutes * 60_000;
}

async function windowsOf(ctx: BookingCtx, staff: string, day: string): Promise<Window[]> {
  const base = midnight(day, ctx.utcOffsetMinutes ?? 240);
  const exception = await ctx.db.query<{ open_min: number; close_min: number }>("select open_min, close_min from booking__hours where staff_id = ? and day = ?", [staff, day]);
  const weekday = new Date(base + (ctx.utcOffsetMinutes ?? 240) * 60_000).getUTCDay();
  const rows = exception.length > 0 ? exception : await ctx.db.query<{ open_min: number; close_min: number }>("select open_min, close_min from booking__hours where staff_id = ? and day is null and weekday = ?", [staff, weekday]);
  return rows.filter((r) => r.close_min > r.open_min).map((r) => ({ open: base + r.open_min * 60_000, close: base + r.close_min * 60_000 }));
}

async function busyOf(ctx: BookingCtx, staff: string, from: number, to: number, now: number): Promise<Busy[]> {
  return ctx.db.query<Busy>(
    "select start_at as start, end_at as end from booking__bookings where staff_id = ? and start_at < ? and end_at > ? and (status = 'confirmed' or (status = 'held' and expires_at > ?))",
    [staff, to, from, now],
  );
}

export async function slots(ctx: BookingCtx, service: unknown, day: unknown, opts: { staff?: string } = {}, now = Date.now()) {
  const s = await ctx.db.queryOne<{ id: string; minutes: number; buffer: number }>("select id, minutes, buffer from booking__services where id = ?", [service]);
  if (s === null) throw new BookingError("no such service", "NOT_FOUND");
  if (typeof day !== "string") throw new BookingError("day: YYYY-MM-DD", "INVALID");
  const staff = await ctx.db.query<{ staff_id: string }>("select staff_id from booking__staff_services where service_id = ? order by staff_id", [s.id]);
  const out: { start: number; end: number; staff: string }[] = [];
  for (const { staff_id } of staff) {
    if (opts.staff !== undefined && opts.staff !== staff_id) continue;
    const windows = await windowsOf(ctx, staff_id, day);
    if (windows.length === 0) continue;
    const busy = await busyOf(ctx, staff_id, Math.min(...windows.map((w) => w.open)), Math.max(...windows.map((w) => w.close)), now);
    for (const slot of freeSlots(windows, busy, s.minutes, s.buffer, Number(ctx.config.slot_minutes ?? 15), now)) out.push({ ...slot, staff: staff_id });
  }
  return out.sort((a, b) => a.start - b.start || (a.staff < b.staff ? -1 : 1));
}

const newId = (): string => `bk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export async function hold(ctx: BookingCtx, service: unknown, staff: unknown, start: unknown, customer: unknown, now = Date.now()) {
  if (typeof start !== "number" || typeof staff !== "string" || typeof customer !== "string" || customer.length === 0) throw new BookingError("service, staff, start (ms), customer", "INVALID");
  const s = await ctx.db.queryOne<{ minutes: number; buffer: number }>("select minutes, buffer from booking__services where id = ?", [service]);
  if (s === null) throw new BookingError("no such service", "NOT_FOUND");
  const day = new Date(start + (ctx.utcOffsetMinutes ?? 240) * 60_000).toISOString().slice(0, 10);
  const free = await slots(ctx, service, day, { staff }, now);
  if (!free.some((f) => f.start === start)) throw new BookingError("the slot is taken or outside the hours", "TAKEN");
  const id = newId();
  const expires = now + Number(ctx.config.hold_minutes ?? 10) * 60_000;
  await ctx.db.execute("insert into booking__bookings (id, service_id, staff_id, customer, start_at, end_at, status, expires_at, created_at) values (?, ?, ?, ?, ?, ?, 'held', ?, ?)", [id, service, staff, customer, start, start + s.minutes * 60_000, expires, now]);
  return { id, expires_at: expires };
}

export async function confirm(ctx: BookingCtx, id: unknown, now = Date.now()) {
  const b = await ctx.db.queryOne<{ id: string; status: string; expires_at: number | null }>("select id, status, expires_at from booking__bookings where id = ?", [id]);
  if (b === null) throw new BookingError("no such booking", "NOT_FOUND");
  if (b.status === "held" && (b.expires_at ?? 0) <= now) throw new BookingError("the hold expired", "TAKEN");
  if (b.status !== "held" && b.status !== "confirmed") throw new BookingError("cancelled", "TAKEN");
  await ctx.db.execute("update booking__bookings set status = 'confirmed', expires_at = null where id = ?", [b.id]);
  await ctx.events.emit("booking.confirmed", { booking_id: b.id });
  return ctx.db.queryOne("select id, service_id, staff_id, customer, start_at, end_at, status from booking__bookings where id = ?", [b.id]);
}

export async function cancel(ctx: BookingCtx, id: unknown): Promise<boolean> {
  return (await ctx.db.execute("update booking__bookings set status = 'cancelled' where id = ? and status != 'cancelled'", [id])).changes > 0;
}
