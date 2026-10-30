// GET <mount>/users?q=: the app's users (auth's public view) with whether
// each holds the admin role. POST ?/grant and ?/revoke (user_id): the admin
// role (admin.users, sensitive); an admin cannot revoke their own role.
import { admin, type Page } from "../lib/page.ts";

async function view(ctx: Page, notice: string | null) {
  const q = (ctx.url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
  const rows = await ctx.db.query<{ id: string; email: string; display_name: string | null; created_at: number }>(
    "select id, email, display_name, created_at from auth__public_users_v1 where lower(email) like ? or lower(coalesce(display_name, '')) like ? order by created_at desc limit 200",
    [`%${q}%`, `%${q}%`],
  );
  const me = (ctx.principal as { id: string }).id;
  const users = [];
  for (const u of rows) {
    const roles = (await ctx.authz.roles.list(u.id)).map((r) => r.role);
    users.push({ id: u.id, email: u.email, name: u.display_name ?? "", admin: roles.includes("admin"), self: u.id === me });
  }
  return { q, users, notice };
}

export const guard = { action: "admin.access" };

export const load = admin((ctx) => view(ctx, null));

const userId = (ctx: Page): string => {
  const v = ctx.form.get("user_id");
  if (typeof v !== "string" || !/^[0-9a-f]{32}$/u.test(v)) throw new Error("a user id");
  return v;
};

export const actions = {
  grant: admin(async (ctx) => {
    await ctx.authz.require("admin.users");
    await ctx.authz.roles.assign(userId(ctx), "admin");
    return view(ctx, "granted");
  }),
  revoke: admin(async (ctx) => {
    await ctx.authz.require("admin.users");
    const id = userId(ctx);
    if (id === (ctx.principal as { id: string }).id) return view(ctx, "self");
    await ctx.authz.roles.revoke(id, "admin");
    return view(ctx, "revoked");
  }),
};
