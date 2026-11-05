// GET /api/health answers {"ok":true}: a route for uptime checks.
//
// Every file under functions/ is a route: its path is the URL, and each
// exported HTTP method (GET, POST, ...) handles that method.
import type { Handler } from "@renoxium/sdk";

export const GET: Handler = () => Response.json({ ok: true });
