// The email module's services (#328): see lib/core.ts.
import * as core from "./lib/core.ts";

type Ctx = core.EmailCtx;

export const send = (ctx: Ctx, msg: { to?: unknown; subject?: unknown; text?: unknown; html?: unknown }) => core.send(ctx, msg ?? {});
export const status = (ctx: Ctx, id: unknown) => core.status(ctx, id);
export const suppress = (ctx: Ctx, address: unknown, reason: unknown) => core.suppress(ctx, address, reason);
export const unsuppress = (ctx: Ctx, address: unknown) => core.unsuppress(ctx, address);
export const suppressed = (ctx: Ctx, address: unknown) => core.suppressed(ctx, address);
