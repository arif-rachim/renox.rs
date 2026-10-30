// The booking module's services (#334): see lib/core.ts.
import * as core from "./lib/core.ts";
import { wired } from "./lib/wire.ts";

type Ctx = core.BookingCtx;

export const slots = (ctx: Ctx, service: unknown, day: unknown, opts?: { staff?: string }) => core.slots(ctx, service, day, opts ?? {});
/** Holds a slot; a service with a deposit answers the checkout's pay_url (the booking is confirmed when it is paid). */
export const hold = (ctx: Ctx, service: unknown, staff: unknown, start: unknown, customer: unknown) => core.hold(wired(ctx), service, staff, start, customer);
export const book = hold;
export const confirm = (ctx: Ctx, id: unknown) => core.confirm(ctx, id);
export const cancel = (ctx: Ctx, id: unknown) => core.cancel(ctx, id);
export const noShow = (ctx: Ctx, id: unknown) => core.noShow(ctx, id);
export const addService = (ctx: Ctx, s: Parameters<typeof core.addService>[1]) => core.addService(ctx, s ?? {});
export const addStaff = (ctx: Ctx, s: Parameters<typeof core.addStaff>[1]) => core.addStaff(ctx, s ?? {});
export const setHours = (ctx: Ctx, staff: unknown, when: unknown, open: unknown, close: unknown) => core.setHours(ctx, staff, when, open, close);
