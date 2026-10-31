// The Hijri date of a tax document (#336), apart from lib/page.ts so a unit test
// can load it without `renox:modules`.

/**
 * The Hijri date of `ms` in the app's time zone when the page's tag asks for
 * a Hijri calendar (`-u-ca-islamic…`, i18n's `calendar` config), else null
 * (#336). The renderer's `date` filter formats the Gregorian calendar only
 * (ops.md 1.4.0, "the renderer documents which calendars it formats"), so the
 * loader formats this one with Intl, in the tag's own digits (`nu`).
 */
export function hijri(ms: number, tag: string, offsetMinutes: number): string | null {
  if (!/-u-(?:[a-z0-9]+-)*?ca-islamic/u.test(tag.toLowerCase())) return null;
  return new Intl.DateTimeFormat(tag, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(ms + offsetMinutes * 60_000));
}
