// The storage module's services (#332): see lib/core.ts.
import * as core from "./lib/core.ts";

type Ctx = core.StorageCtx;

/** Within the owner's quota (config.quota_mb) and the tier's limits. */
export const upload = (ctx: Ctx, owner: unknown, name: unknown, bytes: unknown, contentType: unknown, opts?: { public?: boolean }) => core.uploadWithin(ctx, owner, name, bytes, contentType, opts ?? {});
export const list = (ctx: Ctx, owner: unknown, opts?: { limit?: number; cursor?: string | null }) => core.list(ctx, owner, opts ?? {});
export const remove = (ctx: Ctx, owner: unknown, name: unknown) => core.remove(ctx, owner, name);
export const link = (ctx: Ctx, owner: unknown, name: unknown, ttl: unknown) => core.link(ctx, owner, name, ttl);
export const quota = (ctx: Ctx, owner: unknown) => core.quota(ctx, owner);
export const sanitizeSvg = (_ctx: Ctx, text: unknown) => (typeof text === "string" ? core.sanitizeSvg(text) : null);
