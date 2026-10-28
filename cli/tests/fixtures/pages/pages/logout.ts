export function load() {
  return new Response(null, { status: 303, headers: { location: "/" } });
}
