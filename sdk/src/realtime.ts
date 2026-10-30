// Realtime helpers (#284; docs/contracts/ops.md section 18). The handler
// shapes (`WsModule`, `SseModule`) and `ctx.realtime` are in ctx.ts; these
// type a module's export and build topics the way the platform checks them.
//
//   // functions/ws/chat/[room].ts
//   export const ws = defineWs({
//     async open(ctx) { await ctx.realtime.subscribe(ctx.conn, topic("room", ctx.params.room as string)); },
//     async message(ctx) { await ctx.realtime.publish(topic("room", ctx.params.room as string), { text: String(ctx.data) }); },
//   });

import type { SseModule, WsModule } from "./ctx.ts";

/** One topic segment: `[A-Za-z0-9_.-]+` (ops.md section 18, "Topics"). */
const SEGMENT = /^[A-Za-z0-9_.-]+$/u;

/** Topics are at most 256 characters. */
export const MAX_TOPIC_LENGTH = 256;

/** Whether `t` is a topic the platform accepts (`room:42`, `user:u_1:inbox`). */
export function isTopic(t: string): boolean {
  return typeof t === "string" && t.length > 0 && t.length <= MAX_TOPIC_LENGTH && t.split(":").every((s) => SEGMENT.test(s));
}

/**
 * A topic from its segments, joined with `:`. Throws a RangeError for a
 * segment outside `[A-Za-z0-9_.-]+` (a `:` inside a segment would change
 * the topic) or a topic over 256 characters, as `ctx.realtime` does.
 */
export function topic(...segments: readonly (string | number)[]): string {
  const parts = segments.map(String);
  for (const p of parts) if (!SEGMENT.test(p)) throw new RangeError(`topic: segment ${JSON.stringify(p)} is not [A-Za-z0-9_.-]+`);
  const t = parts.join(":");
  if (t.length === 0 || t.length > MAX_TOPIC_LENGTH) throw new RangeError("topic: 1 to 256 characters");
  return t;
}

/** Types a `functions/ws/**` module's `ws` export and returns it unchanged. */
export function defineWs<const M extends WsModule>(handlers: M): M {
  return handlers;
}

/** Types a `functions/sse/**` module's `sse` export and returns it unchanged. */
export function defineSse<const M extends SseModule>(handlers: M): M {
  return handlers;
}
