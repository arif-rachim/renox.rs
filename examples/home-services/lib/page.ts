// What every page's layout reads from its data (pages/_layouts/main.html):
// `brand`, `i18n_links`, `auth_user`, `notif_badge` and the header's
// `org_switcher`. Loaders and actions call `shell(ctx)` and spread the result.
//
// The owner's first page after signing in also finishes the platform's setup
// (#711, lib/setup.ts finishSetup): the branches become `org` organisations
// and the people are invited. A failure there is logged and retried on the
// next page; the page itself still renders. Only a loader does it, in a
// transaction of its own: an action's transaction is the action's.
import type { Authz, DbStatements, LoaderContext } from "@renoxium/sdk";
import { auth, i18n, notifications, org } from "renox:modules";

import type { Scopable } from "./scope";
import { finishSetup } from "./setup";
import { brandColor, brandFooter, brandName, getSettings, logoSrc } from "./settings";

type ShellCtx = Pick<LoaderContext, "setLocale" | "url" | "log"> & {
  readonly db: Scopable & { transaction?<T>(fn: (tx: DbStatements) => Promise<T>): Promise<T> };
  readonly authz: Pick<Authz, "roles">;
  readonly principal: { readonly id: string } | null;
};

type Transactional = ShellCtx & { readonly db: ShellCtx["db"] & { transaction<T>(fn: (tx: DbStatements) => Promise<T>): Promise<T> } };
/** A loader's `db` opens transactions; an action's is one already. */
const inLoader = (ctx: ShellCtx): ctx is Transactional => typeof ctx.db.transaction === "function";

/** The page's locale is set as a side effect (user, then organisation, then the browser). */
export async function shell(ctx: ShellCtx) {
  const { db, setLocale, url } = ctx;
  const user = await auth.currentUser();
  let settings = await getSettings(db);
  if (user !== null && settings.setup_pending !== undefined && inLoader(ctx)) {
    try {
      if (await finishSetup(ctx, user, settings)) settings = await getSettings(db);
    } catch (e) {
      ctx.log.error("setup: finishing failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const switcher = await org.switcher(url.pathname);
  const r = await i18n.detectLocale({ user_id: user?.id ?? null, org_locale: switcher?.current?.locale ?? null });
  setLocale(r.locale, r.dir);
  const lang = r.locale === "ar" ? "ar" : "en";
  return {
    auth_user: user,
    org_switcher: switcher,
    i18n_links: r.alternates,
    notif_badge: await notifications.badge(),
    locale: r.locale,
    brand: {
      name: brandName(settings, lang),
      logo: logoSrc(settings),
      color: brandColor(settings),
      footer: brandFooter(settings, lang),
    },
  };
}
