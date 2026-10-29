// The whatsapp module's services (#290): see lib/core.ts.
import * as api from "./lib/cloud-api.ts";
import * as core from "./lib/core.ts";

type Ctx = core.WaCtx;

export const send = (ctx: Ctx, to: unknown, text: unknown) => core.send(ctx, to, text);
export const sendTemplate = (ctx: Ctx, to: unknown, name: unknown, params?: unknown, language?: unknown) => core.sendTemplate(ctx, to, name, params ?? [], language ?? "en");
export const sendOtp = (ctx: Ctx, phone: unknown) => core.sendOtp(ctx, phone);
export const verifyOtp = (ctx: Ctx, phone: unknown, code: unknown) => core.verifyOtp(ctx, phone, code);
export const linkPhone = (ctx: Ctx, userId: unknown, phone: unknown) => core.linkPhone(ctx, userId, phone);
export const inbox = (ctx: Ctx, filter?: { phone?: string; direction?: "in" | "out"; limit?: number }) => core.inbox(ctx, filter ?? {});

export async function chatLink(_ctx: Ctx, phone: unknown, text: unknown): Promise<{ url: string } | null> {
  const p = api.normalizePhone(phone);
  return p === null ? null : { url: api.chatLink(p, typeof text === "string" ? text : "") };
}
