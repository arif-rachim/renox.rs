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
  /** Reminders as jobs of this module (ops.md section 20). */
  jobs?: { enqueue(name: string, payload: Readonly<Record<string, unknown>>, options?: { runAt?: number }): Promise<string> };
  /** A deposit's checkout (billing, #329); absent when the service takes none. */
  deposit?: (o: { order_id: string; customer_id: string; amount: number; description: string }) => Promise<{ url: string }>;
  /** The app's offset from UTC in minutes (Asia/Dubai: 240). */
  utcOffsetMinutes?: number;
}

export class BookingError extends Error {
  constructor(message: string, readonly code: "INVALID" | "TAKEN" | "NOT_FOUND" | "FORBIDDEN") {
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
  // An expired hold on this start no longer counts (the unique index sees live rows only).
  await ctx.db.execute("update booking__bookings set status = 'cancelled' where staff_id = ? and start_at = ? and status = 'held' and expires_at <= ?", [staff, start, now]);
  try {
    await ctx.db.execute("insert into booking__bookings (id, service_id, staff_id, customer, start_at, end_at, status, expires_at, created_at) values (?, ?, ?, ?, ?, ?, 'held', ?, ?)", [id, service, staff, customer, start, start + s.minutes * 60_000, expires, now]);
  } catch {
    // Another booking took the same staff and start between the search and the write.
    throw new BookingError("the slot is taken or outside the hours", "TAKEN");
  }
  const deposit = (await ctx.db.queryOne<{ deposit_fils: number; name: string }>("select deposit_fils, name from booking__services where id = ?", [service])) as { deposit_fils: number; name: string };
  if (deposit.deposit_fils > 0 && ctx.deposit !== undefined) {
    const order = `booking:${id}`;
    const r = await ctx.deposit({ order_id: order, customer_id: customer, amount: deposit.deposit_fils, description: `Deposit: ${deposit.name}` });
    await ctx.db.execute("update booking__bookings set deposit_order = ? where id = ?", [order, id]);
    return { id, expires_at: expires, pay_url: r.url };
  }
  return { id, expires_at: expires, pay_url: null };
}

export async function confirm(ctx: BookingCtx, id: unknown, now = Date.now()) {
  const b = await ctx.db.queryOne<{ id: string; status: string; expires_at: number | null }>("select id, status, expires_at from booking__bookings where id = ?", [id]);
  if (b === null) throw new BookingError("no such booking", "NOT_FOUND");
  if (b.status === "held" && (b.expires_at ?? 0) <= now) throw new BookingError("the hold expired", "TAKEN");
  if (b.status !== "held" && b.status !== "confirmed") throw new BookingError("cancelled", "TAKEN");
  const was = b.status;
  await ctx.db.execute("update booking__bookings set status = 'confirmed', expires_at = null where id = ?", [b.id]);
  if (was === "held") {
    await ctx.events.emit("booking.confirmed", { booking_id: b.id });
    const start = (await ctx.db.queryOne<{ start_at: number }>("select start_at from booking__bookings where id = ?", [b.id]))?.start_at ?? now;
    for (const [kind, before] of [["24h", 24 * 3_600_000], ["2h", 2 * 3_600_000]] as const) {
      if (start - before > now) await ctx.jobs?.enqueue("reminder", { booking_id: b.id, kind }, { runAt: start - before });
    }
  }
  return ctx.db.queryOne("select id, service_id, staff_id, customer, start_at, end_at, status from booking__bookings where id = ?", [b.id]);
}

/**
 * Cancels a booking; `by` the customer, only their own. Inside the
 * service's cancellation window (cancel_hours before the start) a paid
 * deposit is retained; outside it, it is to be returned (the event says
 * which; the refund itself is the app's billing.refund).
 */
export async function cancel(ctx: BookingCtx, id: unknown, opts: { customer?: string } = {}, now = Date.now()): Promise<boolean> {
  const b = await ctx.db.queryOne<{ id: string; customer: string; start_at: number; status: string; deposit_order: string | null; cancel_hours: number }>(
    "select b.id, b.customer, b.start_at, b.status, b.deposit_order, s.cancel_hours from booking__bookings b join booking__services s on s.id = b.service_id where b.id = ?",
    [id],
  );
  if (b === null || b.status === "cancelled") return false;
  if (opts.customer !== undefined && opts.customer !== b.customer) throw new BookingError("not your booking", "FORBIDDEN");
  await ctx.db.execute("update booking__bookings set status = 'cancelled' where id = ?", [b.id]);
  const retained = b.deposit_order !== null && b.status === "confirmed" && b.start_at - now < b.cancel_hours * 3_600_000;
  await ctx.events.emit("booking.cancelled", { booking_id: b.id, deposit_retained: retained });
  return true;
}

/** A confirmed booking whose customer did not come (after its start). */
export async function noShow(ctx: BookingCtx, id: unknown, now = Date.now()): Promise<boolean> {
  return (await ctx.db.execute("update booking__bookings set no_show_at = ? where id = ? and status = 'confirmed' and start_at <= ? and no_show_at is null", [now, id, now])).changes > 0;
}

/** A reminder of a confirmed booking, once per kind; null when there is nothing to send. */
export async function reminderDue(ctx: BookingCtx, id: string, kind: "24h" | "2h", now = Date.now()): Promise<{ customer: string; start_at: number; service: string } | null> {
  const b = await ctx.db.queryOne<{ customer: string; start_at: number; status: string; service: string }>("select b.customer, b.start_at, b.status, s.name as service from booking__bookings b join booking__services s on s.id = b.service_id where b.id = ?", [id]);
  if (b === null || b.status !== "confirmed" || b.start_at <= now) return null;
  const fresh = await ctx.db.execute("insert into booking__reminders (booking_id, kind, sent_at) values (?, ?, ?) on conflict do nothing", [id, kind, now]);
  return fresh.changes === 1 ? { customer: b.customer, start_at: b.start_at, service: b.service } : null;
}

// Managing the catalogue (#334): booking.manage when a principal calls.
type Managed = BookingCtx & { authz?: { require(action: string): Promise<void> } };
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export async function addService(ctx: Managed, s: { id?: unknown; name?: unknown; minutes?: unknown; buffer?: unknown; deposit_fils?: unknown; cancel_hours?: unknown }) {
  await ctx.authz?.require("booking.manage");
  if (typeof s.id !== "string" || !ID.test(s.id) || typeof s.name !== "string" || s.name.length === 0) throw new BookingError("id and name", "INVALID");
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d);
  await ctx.db.execute(
    "insert into booking__services (id, name, minutes, buffer, deposit_fils, cancel_hours) values (?, ?, ?, ?, ?, ?) on conflict (id) do update set name = excluded.name, minutes = excluded.minutes, buffer = excluded.buffer, deposit_fils = excluded.deposit_fils, cancel_hours = excluded.cancel_hours",
    [s.id, s.name, n(s.minutes, 30), n(s.buffer, 0), n(s.deposit_fils, 0), n(s.cancel_hours, 24)],
  );
  return { id: s.id };
}

export async function addStaff(ctx: Managed, st: { id?: unknown; name?: unknown; user_id?: unknown; services?: unknown }) {
  await ctx.authz?.require("booking.manage");
  if (typeof st.id !== "string" || !ID.test(st.id) || typeof st.name !== "string" || st.name.length === 0) throw new BookingError("id and name", "INVALID");
  await ctx.db.execute("insert into booking__staff (id, name, user_id) values (?, ?, ?) on conflict (id) do update set name = excluded.name, user_id = excluded.user_id", [st.id, st.name, typeof st.user_id === "string" ? st.user_id : null]);
  for (const svc of Array.isArray(st.services) ? st.services : []) await ctx.db.execute("insert into booking__staff_services (staff_id, service_id) values (?, ?) on conflict do nothing", [st.id, svc]);
  return { id: st.id };
}

/** Weekly hours (weekday 0-6) or a dated exception (day YYYY-MM-DD; open = close = 0 closes the day), in minutes from local midnight. */
export async function setHours(ctx: Managed, staff: unknown, when: unknown, open: unknown, close: unknown) {
  await ctx.authz?.require("booking.manage");
  if (typeof open !== "number" || typeof close !== "number" || open < 0 || close > 1440 || close < open) throw new BookingError("open and close: minutes from midnight", "INVALID");
  if (typeof when === "number" && Number.isInteger(when) && when >= 0 && when <= 6) await ctx.db.execute("insert into booking__hours (staff_id, weekday, open_min, close_min) values (?, ?, ?, ?)", [staff, when, open, close]);
  else if (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(when)) await ctx.db.execute("insert into booking__hours (staff_id, day, open_min, close_min) values (?, ?, ?, ?)", [staff, when, open, close]);
  else throw new BookingError("a weekday 0-6 or a day YYYY-MM-DD", "INVALID");
  return true;
}
