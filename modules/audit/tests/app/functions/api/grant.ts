// Test only: makes the signed-in user an auditor (app code may assign any role).
import { auth } from "renox:modules";

export async function POST(ctx) {
  const user = await auth.requireUser();
  await ctx.authz.roles.assign(user.id, "auditor");
  return Response.json({ ok: true });
}
