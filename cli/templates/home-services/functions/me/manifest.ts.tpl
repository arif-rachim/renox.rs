// GET /me/manifest: the web app manifest of the technician pages, branded from
// the settings (app__settings): name, short name and theme colour. A function
// route because the static content-type table has no `.webmanifest`. `visit.perform`
// like /me itself: a guarded function answers a signed-out request with 403 (only
// page guards redirect to the login). The layout
// links it with crossorigin="use-credentials", so the browser sends the session
// cookie when it fetches the manifest.
import type { Handler } from "@renoxium/sdk";

import { brandColor, getSettings } from "../../lib/settings";

export const guard = { action: "visit.perform" };

export const GET: Handler = async (ctx) => {
  const settings = await getSettings(ctx.db);
  const name = settings.brand_name ?? "";
  const manifest = {
    name,
    short_name: name.slice(0, 12),
    start_url: "/me/",
    scope: "/me/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: brandColor(settings),
    lang: "en",
    dir: "auto",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: { "content-type": "application/manifest+json", "cache-control": "private, max-age=0, must-revalidate" },
  });
};
