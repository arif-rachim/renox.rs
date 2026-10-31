// GET <mount>/calendar?day=: a staff member's day (booking.view_calendar),
// live over <mount>/sse/calendar (the change feed of booking__bookings).
import { guarded, hijri, localeOf, type Page } from "../lib/page.ts";

export const guard = { action: "booking.view_calendar" };

export const load = guarded(async (ctx: Page) => {
  await (ctx as Page & { authz: { require(a: string): Promise<void> } }).authz.require("booking.view_calendar");
  const staff = await ctx.db.queryOne<{ id: string; name: string }>("select id, name from booking__staff where user_id = ?", [(ctx.principal as { id: string }).id]);
  const off = ctx.utcOffsetMinutes ?? 240;
  const asked = ctx.url.searchParams.get("day");
  const day = asked !== null && /^\d{4}-\d{2}-\d{2}$/u.test(asked) && !Number.isNaN(Date.parse(asked)) ? asked : new Date(Date.now() + off * 60_000).toISOString().slice(0, 10);
  const from = Date.parse(`${day}T00:00:00Z`) - off * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const rows = staff === null ? [] : await ctx.db.query<{ id: string; service: string; start_at: number; status: string }>(
    "select b.id, s.name as service, b.start_at, b.status from booking__bookings b join booking__services s on s.id = b.service_id where b.staff_id = ? and b.start_at >= ? and b.start_at < ? and b.status != 'cancelled' order by b.start_at",
    [staff.id, from, from + 86_400_000],
  );
  return {
    staff: staff?.name ?? null,
    day,
    // The day's Hijri date when the page asks for it; the links to the days around it (their arrows mirror in RTL).
    day_hijri: hijri(Date.parse(`${day}T00:00:00Z`) - off * 60_000, localeOf(ctx), off),
    previous: iso(Date.parse(day) - 86_400_000),
    next: iso(Date.parse(day) + 86_400_000),
    bookings: rows.map((r) => ({ id: r.id, service: r.service, at: r.start_at, status: r.status, status_key: `booking.status.${r.status}` })),
  };
});
