// POST /signout: deletes the stored token of this session (lib/session.ts).
// The token itself stays valid at the API until it expires or is revoked
// (`renox tokens revoke`).
import type { ActionContext } from "renox";

import { signOut } from "../lib/session.ts";

const toSignIn = (): Response => new Response(null, { status: 303, headers: { location: "/signin" } });

export function load(): Response {
  return new Response(null, { status: 303, headers: { location: "/apps" } });
}

export const actions = {
  async default({ db, session }: ActionContext) {
    await signOut(db, session.id);
    return toSignIn();
  },
};
