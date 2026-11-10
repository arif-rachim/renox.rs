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

// Caching (#728): the stylesheet is on every page's critical path, so it is
// cached for five minutes by the browser (private: it is the client's brand)
// and revalidated with an ETag, answered 304 without a body. app__settings has
// no `updated_at` column, so the ETag is a hash of the stylesheet itself (the
// settings it prints and the contrast rules), which changes exactly when the
// stylesheet does.
const CACHE_CONTROL = "private, max-age=300";

/** FNV-1a (32 bit) of the text, in hex: a cheap validator, not a security measure. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Whether an `If-None-Match` header names the tag (a list, weak validators and `*` included). */
const matches = (header: string | null, etag: string): boolean => header !== null && header.split(",").some((t) => t.trim() === "*" || t.trim().replace(/^W\//u, "") === etag);

export const GET: Handler = async (ctx) => {
  const color = brandColor(await getSettings(ctx.db));
  const css =
    `:root { --brand: ${color}; }\n` +
    `:root { --brand-ink: ${inkOn(color)}; --brand-line: ${lineOn(color, PAPER.light, "dark")}; }\n` +
    `@media (prefers-color-scheme: dark) { :root { --brand-line: ${lineOn(color, PAPER.dark, "light")}; } }\n`;
  const etag = `"${fnv1a(css)}"`;
  const headers = { "cache-control": CACHE_CONTROL, etag };
  if (matches(ctx.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(css, { headers: { ...headers, "content-type": "text/css; charset=utf-8" } });
};
