// GET /: the landing with the company's brand and a sign-in link. The layout
// reads `brand`, `i18n_links`, `notif_badge` and `auth_user` from the page's data.
import type { LoaderContext } from "@renoxium/sdk";
import { auth, i18n, notifications } from "renox:modules";

import { brandColor, getSettings } from "../lib/settings";

export async function load({ db, setLocale }: LoaderContext) {
  const user = await auth.currentUser();
  const r = await i18n.detectLocale({ user_id: user?.id ?? null, org_locale: null });
  setLocale(r.locale, r.dir);
  const settings = await getSettings(db);
  return {
    auth_user: user,
    i18n_links: r.alternates,
    notif_badge: await notifications.badge(),
    brand: {
      name: settings.brand_name ?? "",
      logo: settings.brand_logo_key === undefined || settings.brand_logo_key === "" ? null : `/files/${settings.brand_logo_key}`,
      color: brandColor(settings),
      footer: r.locale === "ar" ? (settings.brand_footer_ar ?? "") : (settings.brand_footer_en ?? ""),
    },
  };
}
