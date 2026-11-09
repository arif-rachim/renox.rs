// GET /theme: the brand colour from the settings as a stylesheet. The layout
// links it instead of an inline <style>, because templates do not interpolate
// inside <style> and the CSP (`style-src 'self' 'nonce-…'`) refuses style
// attributes. brandColor() only lets a #rrggbb value through, so nothing a
// setting holds can break out of the declaration.
import type { Handler } from "@renoxium/sdk";

import { brandColor, getSettings } from "../lib/settings";

export const GET: Handler = async (ctx) => {
  const color = brandColor(await getSettings(ctx.db));
  return new Response(`:root { --brand: ${color}; }\n`, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" },
  });
};
