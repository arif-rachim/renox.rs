// Checks for a stylesheet built on renox-ui (README.md, "Principles"): no
// physical direction, so dir="rtl" mirrors the page; nothing from another
// origin, so the CSP `default-src 'self'` holds (the one file a sheet may load
// is a same-origin `url(/…)`, the display font of ADR D27); and every text and
// ground pair of the tokens meets WCAG 2.2 AA in light and in dark. Used by
// the apps' tests.

/** Physical properties and values that do not flip under dir="rtl". */
const PHYSICAL =
  /(?:^|[;{\s])(?:margin|padding|border)-(?:left|right|top|bottom)\b|(?:^|[;{\s])(?:left|right|top|bottom)\s*:|text-align\s*:\s*(?:left|right)|float\s*:\s*(?:left|right)|(?:^|[;{\s])(?:width|height|min-width|min-height|max-width|max-height)\s*:/u;

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, "");

/** The lines of `css` (comments removed) that use a physical direction; @media conditions are allowed. */
export function physicalLines(css: string): string[] {
  return stripComments(css)
    .split("\n")
    .filter((l) => !l.trim().startsWith("@media") && PHYSICAL.test(l));
}

/**
 * Whether `css` loads anything from another origin: `@import`, an absolute
 * URL, or a `url()` that is not a root-relative path of this origin. A
 * `url(/doto-black.woff2)` is allowed (D27); `url(//cdn…)` and `url(x.png)`
 * are not.
 */
export function loadsAnything(css: string): boolean {
  const s = stripComments(css);
  if (/@import|https?:\/\//u.test(s)) return true;
  for (const m of s.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gu)) {
    const target = m[2] ?? "";
    if (!/^\/(?!\/)[A-Za-z0-9._/-]+$/u.test(target)) return true;
  }
  return false;
}

/** The tokens a `:root { … }` block sets, by name, for the light scheme and the dark one. */
export function tokens(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const s = stripComments(css);
  const read = (block: string): Map<string, string> => new Map([...block.matchAll(/(--rx-[a-z0-9-]+)\s*:\s*([^;]+);/gu)].map((m) => [m[1] as string, (m[2] as string).trim()]));
  const light = read(/:root\s*\{([^}]*)\}/u.exec(s)?.[1] ?? "");
  const darkBlock = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/u.exec(s)?.[1] ?? "";
  // Dark inherits every token it does not set.
  return { light, dark: new Map([...light, ...read(darkBlock)]) };
}

/** Relative luminance of a `#rrggbb` colour (WCAG 2.2). */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/iu.exec(hex.trim());
  if (m === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt((m[1] as string).slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The text-on-ground pairs renox-ui promises (README.md, "Tokens"), with the
 * ratio each needs: 4.5 for normal text, 3 for large text and user-interface
 * parts. The accent is never body text, so it has no pair here.
 */
export const PAIRS: readonly [text: string, ground: string, minimum: number][] = [
  ["--rx-ink", "--rx-paper", 4.5],
  ["--rx-ink", "--rx-surface", 4.5],
  ["--rx-ink", "--rx-sunken", 4.5],
  ["--rx-ink-2", "--rx-paper", 4.5],
  ["--rx-ink-2", "--rx-surface", 4.5],
  ["--rx-ink-2", "--rx-sunken", 4.5],
  ["--rx-muted", "--rx-paper", 4.5],
  ["--rx-muted", "--rx-surface", 4.5],
  ["--rx-muted", "--rx-sunken", 4.5],
  ["--rx-pill-ink", "--rx-pill", 4.5],
  ["--rx-accent-ink", "--rx-accent", 3],
  ["--rx-ok", "--rx-paper", 4.5],
  ["--rx-ok", "--rx-surface", 4.5],
  ["--rx-ok", "--rx-ok-bg", 4.5],
  ["--rx-warn", "--rx-paper", 4.5],
  ["--rx-warn", "--rx-surface", 4.5],
  ["--rx-warn", "--rx-warn-bg", 4.5],
  ["--rx-bad", "--rx-paper", 4.5],
  ["--rx-bad", "--rx-bad-bg", 4.5],
  ["--rx-rule-strong", "--rx-paper", 1.5],
];

/** The pairs of `PAIRS` that `css` fails in either scheme, as "scheme text on ground: ratio < minimum" lines. */
export function contrastFailures(css: string): string[] {
  const t = tokens(css);
  const out: string[] = [];
  for (const [scheme, map] of [["light", t.light], ["dark", t.dark]] as const) {
    for (const [text, ground, minimum] of PAIRS) {
      const [a, b] = [map.get(text), map.get(ground)];
      if (a === undefined || b === undefined) {
        out.push(`${scheme} ${text} on ${ground}: token missing`);
        continue;
      }
      const ratio = contrast(a, b);
      if (ratio < minimum) out.push(`${scheme} ${text} on ${ground}: ${ratio.toFixed(2)} < ${minimum}`);
    }
  }
  return out;
}
