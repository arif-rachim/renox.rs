// WCAG 2.2 contrast for the client's brand colour (#727): the text on a brand
// button is black or white, whichever has the higher ratio (never assumed
// white), and a line or focus ring in the brand colour is darkened (light mode)
// or lightened (dark mode) until it is 3:1 against the page. /theme prints the
// results as custom properties; tests/a11y.test.ts checks them for many colours.

/** The paper the shared stylesheet (renox-ui.css) draws pages on, light and dark. */
export const PAPER = { light: "#efeeea", dark: "#121211" } as const;

type Rgb = [number, number, number];

function parse(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function print([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = parse(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two #rrggbb colours, 1 to 21. */
export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `background`. */
export function inkOn(background: string): "#000000" | "#ffffff" {
  return ratio("#000000", background) >= ratio("#ffffff", background) ? "#000000" : "#ffffff";
}

/** `color` moved towards black (`toward` "dark") or white until it has `min`:1 against `page`; unchanged when it already has. */
export function lineOn(color: string, page: string, toward: "dark" | "light", min = 3): string {
  if (ratio(color, page) >= min) return color;
  const end: Rgb = toward === "dark" ? [0, 0, 0] : [255, 255, 255];
  const from = parse(color);
  for (let step = 1; step <= 100; step++) {
    const mixed = print(from.map((v, i) => v + ((end[i] as number) - v) * (step / 100)) as Rgb);
    if (ratio(mixed, page) >= min) return mixed;
  }
  return print(end);
}
