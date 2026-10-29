// The app's page: the locale from i18n with the signed-in user (auth) and
// an organisation default from `?org=` (standing in for the org module),
// passed to ctx.setLocale (ops.md 1.3.0 section 14, "Locale").
import { auth, i18n } from "renox:modules";

export async function load(ctx) {
  const user = await auth.currentUser();
  const r = await i18n.detectLocale({ user_id: user?.id ?? null, org_locale: ctx.url.searchParams.get("org") });
  ctx.setLocale(r.locale, r.dir);
  return { i18n: r };
}
