// What org's pages share: redirects, the login hop, and the answer to a
// refused call (403; 401 sends the visitor to sign in).
import { auth, i18n } from "renox:modules";

import { currentOrg, OrgError, type OrgCtx, session } from "./core.ts";

export type Page = OrgCtx & { url: URL; form: FormData; params: Record<string, string | undefined>; setLocale?: (locale: string, dir?: "ltr" | "rtl") => void };

/**
 * The page's locale from the i18n module (#244), with the user and the
 * active organisation's default; i18n returns it, the page sets it (ops.md
 * 1.3.0 section 14, "Locale"). The response of a hook filler that halted detection, or null.
 */
async function applyLocale(ctx: Page): Promise<Response | null> {
  const s = await session();
  const org = s === null ? null : await currentOrg(ctx);
  const r = (await i18n.detectLocale({ user_id: s?.user.id ?? null, org_locale: org?.locale ?? null })) as { locale: string; dir: "ltr" | "rtl"; halt?: Response };
  ctx.setLocale?.(r.locale, r.dir);
  return r.halt ?? null;
}

export const redirect = (location: string): Response => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

/** auth's login page, coming back to this page. */
export async function toLogin(ctx: Page): Promise<Response> {
  return redirect((await auth.loginUrl(ctx.url.pathname + ctx.url.search)) as string);
}

export const forbidden = (): Response =>
  new Response("<!doctype html><title>Not allowed</title><p>You are not allowed to do that in this organisation.</p>", {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

/** Runs a load or an action with the page's locale set; a refused call answers 403, or the login hop. */
export function guarded<T>(fn: (ctx: Page) => Promise<T>): (ctx: Page) => Promise<T | Response> {
  return async (ctx) => {
    try {
      return (await applyLocale(ctx)) ?? (await fn(ctx));
    } catch (e) {
      if (e instanceof OrgError) return e.code === "AUTH_REQUIRED" ? toLogin(ctx) : forbidden();
      throw e;
    }
  };
}
