// GET /: the app list is the dashboard's home (docs/19-platform-wireframes.md, 3.1).
export function load(): Response {
  return new Response(null, { status: 303, headers: { location: "/apps" } });
}
