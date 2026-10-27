// GET /api/check -> { results: [{ package, version, ok, error?, ms }] }
// Runs every B17 check (docs/14-benchmarks.md) inside whatever runtime serves it.
import { runAll } from "../../checks/_run.ts";

// TODO(F1-17): import { Handler } from "renox"
type Handler = (ctx: { req: Request }) => Response | Promise<Response>;

export const GET: Handler = async () => Response.json({ results: await runAll() });
