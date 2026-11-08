// What every page's layout reads from its data (pages/_layouts/main.html):
// `brand`, `i18n_links`, `auth_user`, `notif_badge` and the header's
// `org_switcher`. Loaders and actions call `shell(ctx)` and spread the result.
import type { DbStatements, LoaderContext } from "@renoxium/sdk";
import { auth, i18n, notifications, org } from "renox:modules";

import { brandColor, brandFooter, brandName, getSettings, logoSrc } from "./settings";

type ShellCtx = Pick<LoaderContext, "setLocale" | "url"> & { readonly db: DbStatements };

/** The page's locale is set as a side effect (user, then organisation, then the browser). */
export async function shell({ db, setLocale, url }: ShellCtx) {
  const user = await auth.currentUser();
  const switcher = await org.switcher(url.pathname);
  const r = await i18n.detectLocale({ user_id: user?.id ?? null, org_locale: switcher?.current?.locale ?? null });
  setLocale(r.locale, r.dir);
  const settings = await getSettings(db);
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
