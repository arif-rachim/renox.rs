// GET /api/hello -> {"ok":true}
// The smallest Renox function: used by benchmarks B4, B5, and B11.

import type { Ctx, Handler } from "renox";

// `satisfies` checks it against the contract's Handler while keeping the
// narrower parameter, so tests and the F0 spike adapter can call it with only
// `{ req }`.
export const GET = ((_ctx: Pick<Ctx, "req">) => Response.json({ ok: true })) satisfies Handler;
