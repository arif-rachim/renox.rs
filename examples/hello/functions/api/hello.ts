// GET /api/hello -> {"ok":true}
// The smallest Renox function: used by benchmarks B4, B5, and B11.

// TODO(F1-17): import { Handler } from "renox"
type Handler = (ctx: { req: Request }) => Response | Promise<Response>;

export const GET: Handler = () => Response.json({ ok: true });
