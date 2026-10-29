// The 2fa module's services (#287): see lib/core.ts.
import * as core from "./lib/core.ts";

type Ctx = core.TwofaCtx;

export const isEnrolled = (ctx: Ctx, userId: unknown) => (typeof userId === "string" ? core.isEnrolled(ctx, userId) : Promise.resolve(false));
export const requireRecent = (ctx: Ctx, opts?: { within?: number; next?: string }) => core.requireRecent(ctx, opts ?? {});
export const verifiedAt = (ctx: Ctx, sessionId: unknown) => core.verifiedAt(ctx, sessionId);
