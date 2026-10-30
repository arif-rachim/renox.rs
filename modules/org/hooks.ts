// org runs `org.before_invite` and `org.send_mail` (exports.hooks), and
// fills auth's principal hook (#292): `org` is the session's active
// organisation, which org's policies and the app's compare resources with
// (`resource.org_id == principal.org`).
import { currentOrg, type OrgCtx } from "./lib/core.ts";

export const hooks = {
  "auth.principal": {
    async handle(ctx: OrgCtx, args: { principal: { id: string; attrs: Record<string, unknown> } }) {
      const org = await currentOrg(ctx);
      if (org !== null) args.principal.attrs.org = org.id;
    },
  },
};
export const on = {};
