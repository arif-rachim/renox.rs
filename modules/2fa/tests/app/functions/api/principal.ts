// Test only: the request's principal.
export function GET(ctx) {
  return Response.json(ctx.principal);
}
