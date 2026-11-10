// GET /theme: the brand colour from the settings as a stylesheet. The layout
// links it instead of an inline <style>, because templates do not interpolate
// inside <style> and the CSP (`style-src 'self' 'nonce-…'`) refuses style
// attributes. brandColor() only lets a #rrggbb value through, so nothing a
// setting holds can break out of the declaration.
//
// Accessibility (#727): `--brand-ink` is the text colour on a brand-coloured
// button (black or white by contrast ratio, lib/contrast.ts) and `--brand-line`
// the brand colour as a line or focus ring, adjusted to 3:1 against the page in
// light and in dark mode.
import type { Handler } from "@renoxium/sdk";

import { inkOn, lineOn, PAPER } from "../lib/contrast";
import { brandColor, getSettings } from "../lib/settings";

export const GET: Handler = async (ctx) => {
  const color = brandColor(await getSettings(ctx.db));
  const css =
    `:root { --brand: ${color}; }\n` +
    `:root { --brand-ink: ${inkOn(color)}; --brand-line: ${lineOn(color, PAPER.light, "dark")}; }\n` +
    `@media (prefers-color-scheme: dark) { :root { --brand-line: ${lineOn(color, PAPER.dark, "light")}; } }\n`;
  return new Response(css, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" },
  });
};
