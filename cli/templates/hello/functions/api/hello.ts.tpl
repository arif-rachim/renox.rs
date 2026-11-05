// GET /api/hello answers {"ok":true}.
//
// Every file under functions/ is a route: its path is the URL, and each
// exported HTTP method (GET, POST, PUT, PATCH, DELETE) handles that method.
// A handler receives `ctx` (the request, the app's SQLite database, fetch,
// secrets, log) and returns a Response.

import type { Ctx, Handler } from "@renoxium/sdk";

// `satisfies Handler` checks the handler against the SDK's type while keeping
// the narrower parameter, so a test can call it with only `{ req }`.
export const GET = ((_ctx: Pick<Ctx, "req">) => Response.json({ ok: true })) satisfies Handler;
