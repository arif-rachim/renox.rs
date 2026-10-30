// /ws/chat/<room> (#282; docs/09-htmx-realtime.md): `open` loads the room,
// asks the policy (`room.join`: a private room for its members only; a
// refusal closes the socket with 1008) and subscribes to `room:<id>`;
// `message` renders partials/message.html for the room, off the isolate
// thread, and publishes it to everyone in the room, the sender included.
import { auth } from "renox:modules";

import { asResource, room, topic } from "../../../lib/rooms.ts";

interface WsCtx {
  conn: { id: string };
  params: { room?: string };
  data?: string;
  principal: { id: string } | null;
  db: { queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>; query<T>(sql: string, params?: unknown[]): Promise<T[]> };
  authz: { require(action: string, resource?: unknown): Promise<void> };
  realtime: { subscribe(conn: { id: string }, topic: string): Promise<void>; publish(topic: string, payload: unknown): Promise<number> };
}

/** Signed-in users only: denied before any code runs (anonymous sockets close with 1008). */
export const guard = { action: "room.enter" };

export const ws = {
  async open(ctx: WsCtx) {
    const r = await room(ctx.db, ctx.params.room, ctx.principal?.id ?? null);
    if (r === null) throw new Error("no such room");
    await ctx.authz.require("room.join", asResource(r));
    await ctx.realtime.subscribe(ctx.conn, topic(r.id));
  },

  async message(ctx: WsCtx) {
    let text = "";
    try {
      // The page sends `{ "text": "..." }` (htmx's ws-send sends the form the same way).
      text = String((JSON.parse(ctx.data ?? "{}") as { text?: unknown }).text ?? "").trim();
    } catch {
      return;
    }
    if (text === "" || text.length > 1000) return;
    const me = (await auth.currentUser()) as { display_name: string } | null;
    await ctx.realtime.publish(topic(String(ctx.params.room)), { fragment: "partials/message", data: { m: { author: me?.display_name ?? "someone", text } } });
  },
};
