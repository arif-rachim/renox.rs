// The page locale of auth's pages, from the i18n module (#244): the
// signed-in user's choice, the page session's, `?lang=`, Accept-Language.
// i18n returns it and the loader sets it (ops.md 1.3.0 section 14,
// "Locale"); i18n cannot ask auth for the user itself (no cycle), so auth
// passes the user's id in.
import { i18n } from "renox:modules";

import { type AuthCtx, currentUser } from "./core.ts";

type LocaleCtx = AuthCtx & { setLocale?: (locale: string, dir?: "ltr" | "rtl") => void };

interface Detected {
  locale: string;
  dir: "ltr" | "rtl";
  halt?: Response;
}

/** Sets the page's locale; the response of a hook filler that halted detection, or null. */
export async function applyLocale(ctx: LocaleCtx): Promise<Response | null> {
  const user = await currentUser(ctx);
  const r = (await i18n.detectLocale({ user_id: user?.id ?? null })) as Detected;
  ctx.setLocale?.(r.locale, r.dir);
  return r.halt ?? null;
}

/** A load or an action with the page's locale set first. */
export function localized<C extends LocaleCtx, R>(fn: (ctx: C) => Promise<R> | R): (ctx: C) => Promise<R | Response> {
  return async (ctx) => (await applyLocale(ctx)) ?? fn(ctx);
}

