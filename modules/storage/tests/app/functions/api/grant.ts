// Test only: gives the signed-in user a role (app code may assign any role).
import { auth } from "renox:modules";

export async function POST(ctx) {
  const user = await auth.requireUser();
  await ctx.authz.roles.assign(user.id, ctx.url.searchParams.get("role") ?? "admin");
  return Response.json({ ok: true });
}
