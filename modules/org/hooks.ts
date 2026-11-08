// org runs `org.before_invite` and `org.send_mail` (exports.hooks), and
// fills auth's principal hook (#292): `org` is the session's active
// organisation, which org's policies and the app's compare resources with
// (`resource.org_id == principal.org`).
//
// #590, agent tokens: `auth.agent_orgs` lists the user's organisations for
// the consent page, and for an agent's principal (`agent: true`) `org` is
// the organisation chosen at consent (`org_id`), only while the user is
// still a member of it.
import { currentOrg, type OrgCtx } from "./lib/core.ts";

export const hooks = {
  "auth.principal": {
    async handle(ctx: OrgCtx, args: { principal: { id: string; attrs: Record<string, unknown> }; agent?: boolean; org_id?: string | null }) {
      if (args.agent === true) {
        if (typeof args.org_id !== "string" || args.org_id === "") return;
        const m = await ctx.db.queryOne<{ org_id: string }>("select org_id from org__members where org_id = ? and user_id = ?", [args.org_id, args.principal.id]);
        if (m !== null) args.principal.attrs.org = m.org_id;
        return;
      }
      const org = await currentOrg(ctx);
      if (org !== null) args.principal.attrs.org = org.id;
    },
  },
  "auth.agent_orgs": {
    async handle(ctx: OrgCtx, args: { user_id: string; orgs: { id: string; name: string }[] }) {
      const rows = await ctx.db.query<{ id: string; name: string }>(
        "select o.id, o.name from org__members m join org__orgs o on o.id = m.org_id where m.user_id = ? order by o.name, o.id",
        [String(args.user_id)],
      );
      for (const r of rows) args.orgs.push({ id: r.id, name: r.name });
    },
  },
};
export const on = {};
