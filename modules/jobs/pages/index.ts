// GET <mount>: the app's jobs in four lists (scheduled with the next and
// last run, queued, running, dead with the redacted last error). POST
// ?/retry and ?/cancel act on one run; both need jobs.manage, which the
// app's policy grants (the admin role by default), and are audited.
import { auth, i18n } from "renox:modules";

import * as core from "../lib/core.ts";

type Page = core.JobsCtx & { url: URL; form: FormData; setLocale?: (locale: string, dir?: "ltr" | "rtl") => void };

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
  const lists: Record<string, ReturnType<typeof core.shown>[]> = {};
  for (const s of core.STATES) lists[s] = (await core.list(ctx, s, { limit: 100 })).items.map(core.shown);
  return { ...lists, base: core.basePath(ctx), notice };
}

export const guard = { action: "jobs.read" };

export const load = guarded((ctx) => view(ctx, null));

export const actions = {
  retry: guarded(async (ctx) => {
    await core.retry(ctx, core.id(ctx.form.get("id")));
    return view(ctx, "retried");
  }),
  cancel: guarded(async (ctx) => {
    await core.cancel(ctx, core.id(ctx.form.get("id")));
    return view(ctx, "cancelled");
  }),
};
