// Test only: the request's principal as the cell resolved it (#291).
export function GET(ctx) {
  return Response.json(ctx.principal);
}

// Test only: the app grants the signed-in user a role (app code may assign any).
export async function POST(ctx) {
  await ctx.authz.roles.assign(ctx.principal.id, "editor");
  return Response.json({ ok: true });
}
