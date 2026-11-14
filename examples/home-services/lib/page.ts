// What every page's layout reads from its data (pages/_layouts/main.html):
// `brand`, `i18n_links`, `auth_user`, `notif_badge` and the header's
// `org_switcher`. Loaders and actions call `shell(ctx)` and spread the result.
import type { Authz, LoaderContext } from "@renoxium/sdk";
import { auth, i18n, notifications, org } from "renox:modules";

import { SYNC_PENDING, syncCatalogue } from "./booking-sync";
import type { Scopable } from "./scope";
import { brandColor, brandFooter, brandName, getSettings, logoSrc } from "./settings";

type ShellCtx = Pick<LoaderContext, "setLocale" | "url"> & {
  readonly db: Scopable;
  readonly authz?: Pick<Authz, "can" | "roles">;
};

/** The page's locale is set as a side effect (user, then organisation, then the browser). */
export async function shell(ctx: ShellCtx) {
  const { db, setLocale, url } = ctx;
  const user = await auth.currentUser();
  let settings = await getSettings(db);
  // A sync that a caller without `booking.manage` left pending (lib/booking-sync.ts markSyncPending): the first
  // request of a person who holds the right does it and clears the mark.
  if (settings[SYNC_PENDING] === "1" && ctx.authz !== undefined && (await ctx.authz.can("booking.manage"))) {
    await syncCatalogue({ authz: ctx.authz, db });
    await db.execute("delete from app__settings where key = ?", [SYNC_PENDING]);
    settings = await getSettings(db);
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
