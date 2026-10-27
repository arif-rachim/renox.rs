// F0 spike only: exposes functions/api/hello.ts as a Supabase Edge Runtime
// user worker entry. The runtime calls the `Deno.serve` handler for every
// request routed to this worker; Renox's file routing does not exist yet, so
// every GET is answered by the hello handler. Files starting with `_` are not
// routes (docs/07-app-model.md, "Routing rules").
import { GET } from "../functions/api/hello.ts";

// Minimal declaration of the one Deno global used here, so the file
// type-checks under the Bun workspace without Deno's types.
declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};

export function handle(req: Request): Response | Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  return GET({ req });
}

Deno.serve(handle);
