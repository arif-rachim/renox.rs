// #284: the realtime helpers (docs/contracts/ops.md section 18, "Topics"):
// `topic()` builds a topic the platform accepts and refuses a segment that
// would change it; `defineWs` / `defineSse` type the handler exports.

import { expect, expectTypeOf, test } from "bun:test";

import { type CloseContext, defineSse, defineWs, isTopic, type MessageContext, type RealtimeContext, type SseModule, topic, type WsModule } from "../src/index.ts";

test("topic() joins checked segments; isTopic() is the platform's rule", () => {
  expect(topic("room", 42)).toBe("room:42");
  expect(topic("user", "u_1", "inbox")).toBe("user:u_1:inbox");
  expect(() => topic("room", "a:b")).toThrow(RangeError);
  expect(() => topic("room", "")).toThrow(RangeError);
  expect(() => topic("x".repeat(257))).toThrow(RangeError);
  expect(isTopic("orders:o_1")).toBe(true);
  expect(isTopic("orders::o_1")).toBe(false);
  expect(isTopic("orders o_1")).toBe(false);
  expect(isTopic("")).toBe(false);
});

test("defineWs / defineSse return the handlers and type their contexts", () => {
  const ws = defineWs({
    open(ctx) {
      expectTypeOf(ctx).toEqualTypeOf<RealtimeContext>();
    },
    message(ctx) {
      expectTypeOf(ctx).toEqualTypeOf<MessageContext>();
      expectTypeOf(ctx.data).toEqualTypeOf<string | Uint8Array>();
    },
    close(ctx) {
      expectTypeOf(ctx).toEqualTypeOf<CloseContext>();
    },
  });
  expectTypeOf(ws).toMatchTypeOf<WsModule>();
  expect(typeof ws.message).toBe("function");
  const sse = defineSse({ async open() {} });
  expectTypeOf(sse).toMatchTypeOf<SseModule>();
  expect(Object.keys(sse)).toEqual(["open"]);
});
