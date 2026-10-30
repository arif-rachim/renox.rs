// The booking module's services (#334): see lib/core.ts.
import * as core from "./lib/core.ts";

type Ctx = core.BookingCtx;

export const slots = (ctx: Ctx, service: unknown, day: unknown, opts?: { staff?: string }) => core.slots(ctx, service, day, opts ?? {});
export const hold = (ctx: Ctx, service: unknown, staff: unknown, start: unknown, customer: unknown) => core.hold(ctx, service, staff, start, customer);
export const confirm = (ctx: Ctx, id: unknown) => core.confirm(ctx, id);
export const cancel = (ctx: Ctx, id: unknown) => core.cancel(ctx, id);
