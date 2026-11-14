// GET /me/ping: 204 for a signed-in technician, nothing else. public/me.js asks it
// to know whether the phone is really online and still signed in (`navigator.onLine`
// alone says only that a network interface is up): an answer clears the offline
// banner; a refusal (403 for a signed-out request or a person who does not perform
// visits; a guarded function route does not redirect) or a redirect makes me.js
// delete the saved copies. `x-hs-user` is the signed-in user's id, which me.js
// keeps for the service worker (public/sw.js) to know whose copy it may serve.
// No body, never cached.
import type { Handler } from "@renoxium/sdk";

export const guard = { action: "visit.perform" };

export const GET: Handler = (ctx) =>
  new Response(null, { status: 204, headers: { "cache-control": "no-store", "x-hs-user": ctx.principal?.id ?? "" } });
