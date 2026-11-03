// GET /api/health -> {"ok":true}
import type { Handler } from "@renoxium/sdk";

export const GET: Handler = () => Response.json({ ok: true });
