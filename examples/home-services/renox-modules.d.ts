// The part of `renox:modules` the app uses so far: auth's currentUser,
// i18n's detectLocale and notifications' badge. Later sub-issues add what
// they call.
// `renox dev` writes the complete, generated types to .renox/types/ (#236);
// this file keeps `bun run check` working without them.
declare module "renox:modules" {
  export const auth: {
    currentUser(): Promise<{ id: string; email: string; display_name: string } | null>;
  };
  export const i18n: {
    detectLocale(who?: { user_id?: string | null; org_locale?: string | null }): Promise<{ locale: string; dir: "ltr" | "rtl"; alternates: { locale: string; href: string; current: boolean }[] }>;
  };
  export const notifications: {
    badge(): Promise<{ unread: number } | null>;
  };
}
