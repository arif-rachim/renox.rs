// GET /me/signout (#810): the page the technician pages' script puts in front of the sign-out link while actions
// of this user are saved on the phone and not sent ("<n> actions are saved on this phone and not sent. Sign out
// anyway?"). Only the script knows the count (it is in the phone's IndexedDB), so it writes it into the page.
// "Sign out anyway" posts to the auth module's own `logout` action; the logout is not done here, and what is on
// the phone stays there, per user (public/offline-queue.js).
import type { LoaderContext } from "@renoxium/sdk";

import { shell } from "../../lib/page";

export const guard = { action: "visit.perform" };

export async function load(ctx: LoaderContext) {
  return { ...(await shell(ctx)) };
}
