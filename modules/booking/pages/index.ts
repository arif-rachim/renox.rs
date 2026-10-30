// GET <mount>?service=&day=: the services, then a service's free slots on a
// day (the app's time zone). POST ?/hold (service, staff, start): the
// signed-in customer's hold; a service with a deposit goes to its checkout,
// the others are confirmed at once.
import * as core from "../lib/core.ts";
import { guarded, type Page } from "../lib/page.ts";
import { wired } from "../lib/wire.ts";

const time = (ms: number, offset: number) => new Date(ms + offset * 60_000).toISOString().slice(11, 16);

export const load = guarded(async (ctx: Page) => {
  const services = await ctx.db.query<{ id: string; name: string; minutes: number; deposit_fils: number }>("select id, name, minutes, deposit_fils from booking__services order by name");
  const service = ctx.url.searchParams.get("service");
  const day = ctx.url.searchParams.get("day") ?? new Date(Date.now() + (ctx.utcOffsetMinutes ?? 240) * 60_000).toISOString().slice(0, 10);
  const slots = service === null || !services.some((s) => s.id === service) ? [] : await core.slots(ctx, service, day);
  const staff = new Map((await ctx.db.query<{ id: string; name: string }>("select id, name from booking__staff")).map((s) => [s.id, s.name]));
  return {
    services: services.map((s) => ({ id: s.id, name: s.name, minutes: s.minutes, deposit: s.deposit_fils > 0 ? `AED ${(s.deposit_fils / 100).toFixed(2)}` : null, current: s.id === service })),
    service,
    day,
    slots: slots.map((s) => ({ start: String(s.start), staff: s.staff, staff_name: staff.get(s.staff) ?? s.staff, time: time(s.start, ctx.utcOffsetMinutes ?? 240) })),
    error: null as string | null,
  };
});

export const actions = {
  hold: guarded(async (ctx: Page) => {
    const me = (ctx.principal as { id: string }).id;
    try {
      const h = await core.hold(wired(ctx), ctx.form.get("service"), ctx.form.get("staff"), Number(ctx.form.get("start")), me);
      if (h.pay_url !== null) return new Response(null, { status: 303, headers: { location: h.pay_url, "cache-control": "no-store" } });
      await core.confirm(ctx, h.id);
    } catch (e) {
      if (e instanceof core.BookingError) return new Response(null, { status: 303, headers: { location: `?service=${encodeURIComponent(String(ctx.form.get("service")))}&taken=1`, "cache-control": "no-store" } });
      throw e;
    }
    return new Response(null, { status: 303, headers: { location: "mine", "cache-control": "no-store" } });
  }),
};
