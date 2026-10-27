// F0 spike only: exposes functions/api/check.ts as a Supabase Edge Runtime
// user worker entry, as in examples/hello/_spike. Used by B17 (issue #8).
// Files starting with `_` are not routes (docs/07-app-model.md).
import { GET } from "../functions/api/check.ts";

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};

export function handle(req: Request): Response | Promise<Response> {
  if (req.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  return GET({ req });
}

Deno.serve(handle);
