// #284: `renox build` of the realtime route kinds (artifact.md 1.3):
// `functions/ws/**` and `functions/sse/**` become `ws` / `sse` route
// entries under /ws/ and /sse/ (with their guards), `renox.toml [realtime]`
// goes on the manifest, V26 refuses a feed on a table the migrations do not
// create or with a bad topic, and V21 refuses a route on /mcp.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { BuildError, buildFiles } from "../src/lib/build.ts";
import { RouteError } from "../src/lib/routes.ts";
import { app } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

const CHAT = `export const ws = {
  async open(ctx) { await ctx.realtime.subscribe(ctx.conn, "room:" + ctx.params.room); },
  async message(ctx) { await ctx.realtime.publish("room:" + ctx.params.room, { text: String(ctx.data) }); },
};
`;
const FEED = `export const guard = { action: "order.read" };
export const sse = { async open(ctx) { await ctx.realtime.subscribe(ctx.conn, "orders:o_1"); } };
`;
const TOML = `[app]
name = "live"
timezone = "Asia/Dubai"

[authz]
actions = ["order.read"]

[realtime.feeds]
app__orders = "orders:{org_id}"
`;
const BASE = {
  "renox.toml": TOML,
  "functions/ws/chat/[room].ts": CHAT,
  "functions/sse/orders.ts": FEED,
  "migrations/001_orders.sql": "create table app__orders (id text primary key, org_id text not null, total integer);\n",
};

async function failure(files: Record<string, string>): Promise<Error> {
  const dir = app(files);
  try {
    return (await buildFiles(dir).catch((e: unknown) => e)) as Error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(!worker)("ws and sse modules become route entries; [realtime] goes on the manifest", async () => {
  const dir = app(BASE);
  try {
    const built = await buildFiles(dir);
    const kinds = built.manifest.routes.map((r) => ("path" in r ? `${r.kind} ${r.path} ${r.module}` : r.kind));
    expect(kinds).toEqual(["ws /ws/chat/:room functions/ws/chat/[room]", "sse /sse/orders functions/sse/orders"]);
    expect(built.manifest.routes[1]).toMatchObject({ guard: { action: "order.read" } });
    expect(built.manifest.realtime).toEqual({ feeds: { app__orders: "orders:{org_id}" } });
    expect(built.manifest.entries?.["functions/ws/chat/[room]"]?.exports).toEqual(["ws"]);
    expect(built.files.has("code/functions/sse/orders.js")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!worker)("V26: a feed on a table the migrations do not create, or with a bad topic, refuses the build", async () => {
  const missing = await failure({ ...BASE, "renox.toml": TOML.replace("app__orders =", "app__invoices =") });
  expect(missing).toBeInstanceOf(BuildError);
  expect(missing.message).toContain("V26: app: feed table app__invoices is not created by its migrations");
  const topic = await failure({ ...BASE, "renox.toml": TOML.replace('"orders:{org_id}"', '"orders:{Org Id}"') });
  expect(topic.message).toContain("is not a topic with {column} placeholders");
  const prefix = await failure({ ...BASE, "renox.toml": TOML.replace("app__orders =", "shop__orders =") });
  expect(prefix.message).toContain("feed table shop__orders is not under app__");
});

test.skipIf(!worker)("a ws module without the ws export, and a route on /mcp, are refused", async () => {
  const noExport = await failure({ ...BASE, "functions/ws/chat/[room].ts": "export const open = 1;\n" });
  expect(noExport).toBeInstanceOf(RouteError);
  expect(noExport.message).toContain("functions/ws/chat/[room].ts: a ws route module must export const ws");
  const mcp = await failure({ ...BASE, "functions/mcp.ts": "export async function POST() { return new Response('x'); }\n" });
  expect(mcp).toBeInstanceOf(BuildError);
  expect(mcp.message).toContain("V21: /mcp (functions/mcp) is reserved for the App MCP endpoint");
});

test.skipIf(!worker)("two ws routes of the same shape conflict (V8)", async () => {
  const twoWs = await failure({ ...BASE, "functions/ws/chat/[id].ts": CHAT.replaceAll("room", "id") });
  expect(twoWs.message).toContain("V8: GET /ws/chat/:id (functions/ws/chat/[id]) and /ws/chat/:room (functions/ws/chat/[room]) conflict");
});
