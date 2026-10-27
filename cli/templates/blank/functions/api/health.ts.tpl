// GET /api/health -> {"ok":true}
import type { Handler } from "renox";

export const GET: Handler = () => Response.json({ ok: true });
