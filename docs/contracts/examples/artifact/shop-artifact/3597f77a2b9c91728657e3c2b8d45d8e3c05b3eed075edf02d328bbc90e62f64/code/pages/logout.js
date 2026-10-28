// Transpiled from pages/logout.ts: a .ts-only page, so load() returns a Response.
export function load() {
  return new Response(null, { status: 303, headers: { location: "/" } });
}
