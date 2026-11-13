// GET /my/visits/<job id>/photo/<n>: the n-th photo (1-based, in the order
// taken) of the visit of one of the signed-in customer's jobs (#777), at full
// size. For a portal user only, with the gate of the `/my` pages
// (lib/portal.ts requirePortal); the job and its photos are found through
// `customerDb`, so another customer's visit, an unknown job or a photo number
// past the last is a 404. This route checks the session on every request: the
// platform's image path (/_img, what `<x-image>` writes) is not scoped by
// session, it takes a signed link instead.
//
// A photo the technician took lives in the storage module's folder of the
// visit (`storage/<visit id>/<name>`), which the app's `ctx.storage` cannot
// read (it is confined to `app/`) and the module serves no bytes of: the
// answer is a 303 to a link the module signs for 60 seconds. A photo under
// `app/` (the seed's) is answered here with its bytes. Both `private, no-store`.
import { type Handler, redirect } from "@renoxium/sdk";
import { storage } from "renox:modules";

import { requirePortal } from "../../../../../lib/portal";

const PRIVATE = "private, no-store";
const notFound = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": PRIVATE } });
const LINK_SECONDS = 60;

export const GET: Handler = async (ctx) => {
  const gate = await requirePortal(ctx);
  if (gate instanceof Response) return gate;
  const id = typeof ctx.params.id === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(ctx.params.id) ? ctx.params.id : null;
  const n = typeof ctx.params.n === "string" && /^[1-9]\d{0,3}$/u.test(ctx.params.n) ? Number(ctx.params.n) : null;
  if (id === null || n === null) return notFound();
  const photo = (await gate.cdb.visitPhotos(id))[n - 1];
  if (photo === undefined) return notFound();
  const key = String(photo.file_key);
  // The same split as lib/visit-data.ts imageOf: the module's folder and the file's name.
  const owned = /^storage\/([^/]+)\/([^/]+)$/u.exec(key);
  if (owned !== null) {
    // The module signs only a stored file: a row whose upload never finished is no photo.
    const link = await storage.link(owned[1] as string, owned[2] as string, LINK_SECONDS).catch(() => null);
    if (link === null) return notFound();
    // The module's link is a path of this origin (`/_files/...`); anything else falls back to the visit's page.
    const res = redirect.safe(link.url, { status: 303, fallback: `/my/visits/${id}` });
    res.headers.set("cache-control", PRIVATE);
    return res;
  }
  if (!/^app\/[a-z0-9][a-z0-9/_.-]*$/u.test(key) || key.includes("..")) return notFound();
  try {
    const file = await ctx.storage.get(key);
    const bytes = await ctx.storage.read(key);
    return new Response(bytes as BodyInit, { headers: { "content-type": file.content_type, "cache-control": PRIVATE, "x-content-type-options": "nosniff" } });
  } catch {
    // Not stored (the seed's rows until the dev endpoint stores their files).
    return notFound();
  }
};
