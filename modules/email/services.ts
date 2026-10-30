// The email module's services (#328): see lib/core.ts and lib/templates.ts.
import * as core from "./lib/core.ts";

type Ctx = core.EmailCtx;

/** One of the module's templates, in the recipient's locale: (to, template, data, { locale?, reply_to? }). */
export const send = (ctx: Ctx, to: unknown, template: unknown, data: unknown, opts?: { locale?: unknown; reply_to?: unknown }) => core.sendTemplate(ctx, to, template, data, opts ?? {});
/** A message given whole: { to, subject, text?, html?, reply_to? }. */
export const sendRaw = (ctx: Ctx, msg: { to?: unknown; subject?: unknown; text?: unknown; html?: unknown; reply_to?: unknown }) => core.sendRaw(ctx, msg ?? {});
export const status = (ctx: Ctx, id: unknown) => core.status(ctx, id);
export const suppress = (ctx: Ctx, address: unknown, reason: unknown) => core.suppress(ctx, address, reason);
export const unsuppress = (ctx: Ctx, address: unknown) => core.unsuppress(ctx, address);
export const isSuppressed = (ctx: Ctx, address: unknown) => core.suppressed(ctx, address);
