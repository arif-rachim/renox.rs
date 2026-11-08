// GET /: the landing with the company's brand and a sign-in link. The layout
// reads `brand`, `i18n_links`, `notif_badge` and `auth_user` from the page's data
// (lib/page.ts builds them for every page).
import type { LoaderContext } from "@renoxium/sdk";

import { shell } from "../lib/page";

export async function load(ctx: LoaderContext) {
  return shell(ctx);
}
