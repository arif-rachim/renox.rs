// GET /api/redirect: helper for /api/ssrf?target=redirect. An allowlisted
// host (*.redirect.test, mapped to this app by the test) answers with a 302
// to loopback, so the second hop must be blocked.
import type { Handler } from "renox";

const LOOPBACK = "http://127.0.0.1/";

export const GET: Handler = () => new Response(null, { status: 302, headers: { location: LOOPBACK } });
