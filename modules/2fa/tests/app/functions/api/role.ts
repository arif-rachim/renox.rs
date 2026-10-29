// Test only: a role change, which drops the cell's cached principal (authz.roles_changed).
export async function POST(ctx) {
  await ctx.authz.roles.assign(ctx.principal.id, "viewer");
  return Response.json({ ok: true });
}
