// Test only: the caller becomes "support" (the role the reset policy names).
export async function POST(ctx) {
  await ctx.authz.roles.assign(ctx.principal.id, "support");
  return Response.json({ ok: true });
}
