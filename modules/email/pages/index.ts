// GET <mount>: the message log (the latest 100: recipient, subject,
// template, state, attempts; never a body) and the suppressed addresses.
// Needs email.read_log, which the app's policy grants (admin by default).
// POST ?/lift (address) allows a suppressed address again: email.manage.
import { auth, i18n } from "renox:modules";

import * as core from "../lib/core.ts";

type Page = core.EmailCtx & {
  url: URL;
  form: FormData;
  principal?: { kind: string; id: string } | null;
  authz: { require(action: string, resource?: unknown): Promise<void> };
  setLocale?: (locale: string, dir?: "ltr" | "rtl") => void;
};

const redirect = (location: string): Response => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

function guarded<T>(fn: (ctx: Page) => Promise<T>): (ctx: Page) => Promise<T | Response> {
  return async (ctx) => {
    const r = (await i18n.detectLocale({ user_id: ctx.principal?.id ?? null })) as { locale: string; dir: "ltr" | "rtl"; halt?: Response };
    ctx.setLocale?.(r.locale, r.dir);
    if (r.halt) return r.halt;
    if (!ctx.principal || ctx.principal.kind === "anonymous") return redirect((await auth.loginUrl(ctx.url.pathname + ctx.url.search)) as string);
    return fn(ctx);
  };
}

async function view(ctx: Page, notice: string | null) {
  await ctx.authz.require("email.read_log");
  const messages = await ctx.db.query<{ id: string; to_address: string; subject: string; template: string | null; status: string; attempts: number; at: number }>(
    "select id, to_address, subject, template, status, attempts, at from email__messages order by at desc limit 100",
  );
  const suppressions = await ctx.db.query<{ address: string; reason: string; at: number }>("select address, reason, at from email__suppressions order by at desc limit 100");
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/u, "Z");
  return {
    messages: messages.map((m) => ({ ...m, template: m.template ?? "-", at: iso(m.at) })),
    suppressions: suppressions.map((s) => ({ ...s, at: iso(s.at) })),
    notice,
  };
}

export const guard = { action: "email.read_log" };

export const load = guarded((ctx) => view(ctx, null));

export const actions = {
  lift: guarded(async (ctx) => {
    await ctx.authz.require("email.manage");
    await core.unsuppress(ctx, ctx.form.get("address"));
    return view(ctx, "lifted");
  }),
};
