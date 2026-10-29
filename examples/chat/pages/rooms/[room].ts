// GET /rooms/<room> (#282): the room page. The same policy as the socket:
// a room the user may not join answers 403 here too.
import { auth } from "renox:modules";

import { asResource, room } from "../../lib/rooms.ts";

interface Ctx {
  params: { room?: string };
  principal: { id: string } | null;
  db: { queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>; query<T>(sql: string, params?: unknown[]): Promise<T[]> };
  authz: { can(action: string, resource?: unknown): Promise<boolean> };
}

/** Signed-in users only: denied before any code runs (anonymous sockets close with 1008). */
export const guard = { action: "room.enter" };

export async function load(ctx: Ctx) {
  if (ctx.principal === null) return Response.redirect((await auth.loginUrl(`/rooms/${ctx.params.room ?? ""}`)) as string, 303);
  const r = await room(ctx.db, ctx.params.room, ctx.principal.id);
  if (r === null) return new Response("Not found", { status: 404 });
  if (!(await ctx.authz.can("room.join", asResource(r)))) return new Response("Forbidden", { status: 403 });
  return { room: { id: r.id, name: r.name }, socket: `/ws/chat/${r.id}`, auth_user: await auth.currentUser() };
}
