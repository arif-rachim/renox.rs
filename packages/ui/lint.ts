// Checks for a stylesheet built on renox-ui (README.md, "Principles"): no
// physical direction, so dir="rtl" mirrors the page, and nothing from another
// origin, so the CSP `default-src 'self'` holds. Used by the apps' tests.

/** Physical properties and values that do not flip under dir="rtl". */
const PHYSICAL =
  /(?:^|[;{\s])(?:margin|padding|border)-(?:left|right|top|bottom)\b|(?:^|[;{\s])(?:left|right|top|bottom)\s*:|text-align\s*:\s*(?:left|right)|float\s*:\s*(?:left|right)|(?:^|[;{\s])(?:width|height|min-width|min-height|max-width|max-height)\s*:/u;

/** The lines of `css` (comments removed) that use a physical direction; @media conditions are allowed. */
export function physicalLines(css: string): string[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("@media") && PHYSICAL.test(l));
}

/** Whether `css` loads anything: url(), @import or an absolute URL. */
export function loadsAnything(css: string): boolean {
  return /url\(|@import|https?:\/\//u.test(css.replace(/\/\*[\s\S]*?\*\//gu, ""));
}
