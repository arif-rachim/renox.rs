// The Browser errors page and its status action (#128, docs/19-platform-wireframes.md 3.5)
// against the real control API (in process): groups from ingested client
// lines, the original TypeScript position from a privately uploaded
// sourcemap, the 80 % quota warning, and the link from a client log line to
// its group. Rendering is checked through the worker in dashboard.e2e.test.ts.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { contentHash, writeTar } from "@renox/artifact-validate";

import { helloArtifact, upload } from "../../api/tests/artifacts.ts";
import { logIngest } from "../../api/src/ingest/logs.ts";
import { assertScoped, createApp_, registeredNode, scopedToken, tenant } from "../../api/tests/helpers.ts";
import { load as errorsLoad, actions as errorsActions } from "../pages/apps/[app]/client-errors.ts";
import { load as logsLoad } from "../pages/apps/[app]/logs.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, dash, loaderCtx, type Dash } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);

const HELLO = { app: "hello" };
type Data = Record<string, any>;
const data = (v: unknown): Data => {
  expect(v).not.toBeInstanceOf(Response);
  return v as Data;
};

async function setup(scopes?: string[]): Promise<{ d: Dash; hash: string; node: string }> {
  const d = await dash();
  const owner = await tenant(d.h, "t_hello");
  await createApp_(d.h, owner, "hello");
  const files = helloArtifact();
  expect((await upload(d.h, owner, "hello", files)).status).toBe(201);
  const node = await registeredNode(d.h, "node-1");
  const token = scopes === undefined ? owner : await scopedToken(d.h, "t_hello", scopes);
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token, next: "/apps" }))).toBeInstanceOf(Response);
  return { d, hash: contentHash(files), node };
}

let seq = 0;
const clientLine = (hash: string, message: string, file = "/islands/cart.js") => {
  seq += 1;
  return {
    ts: Date.now() - 60_000 + seq,
    tenant_id: "t_hello",
    deployment_hash: hash,
    request_id: `01JBQ3Z7M8K5V6W9X2Y4A1B${String(seq).padStart(3, "0")}`,
    module: "client",
    level: "error",
    message: `js.error: ${message}`,
    fields: { source: "client", kind: "js.error", client_ts: 1, url: "/cart", ua: "chrome", session_fingerprint: "abcdefghijklmnop", detail: { message, stack: [{ file, line: 1, column: 1, function: "updateTotal" }] } },
    source: "client",
  };
};
const ingest = async (s: { d: Dash; node: string }, lines: unknown[]) =>
  expect((await s.d.h.request("POST", "/v1/ingest/logs", { token: s.node, json: { type: "log_batch", schema_version: 0, node_id: "node-1", lines } })).status).toBe(202);

describe("Browser errors (3.5)", () => {
  test("groups with count, last seen, top frame and a bar per deployment; a mapped frame shows the TypeScript position", async () => {
    const s = await setup();
    const map = { version: 3, sources: ["islands/cart.ts"], names: [], mappings: "AAAA" };
    const maps = new Map([["public/islands/cart.js.map", new TextEncoder().encode(JSON.stringify(map))]]);
    // `renox deploy` uploads the map (PUT …/sourcemaps); the harness stores it the same way.
    await ingest(s, [clientLine(s.hash, "boom 1"), clientLine(s.hash, "boom 2")]);
    await s.d.h.store.put(`sourcemaps/t_hello/${s.hash}.tar`, writeTar(maps));
    const r = data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO })));
    expect(r.problem).toBeNull();
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ kind: "js.error", count: "2", status: "open", regressed: false, can_resolve: true, can_reopen: false });
    expect(r.groups[0].top).toMatchObject({ text: "islands/cart.ts:1:1", mapped: true, raw: "/islands/cart.js:1:1" });
    expect(r.groups[0].spark).toHaveLength(1);
    // The sourcemap is never part of what the page links to.
    expect(JSON.stringify(r)).not.toContain(".map");
  });

  test("a group's detail lists its events with a link to the server lines of the same request", async () => {
    const s = await setup();
    await ingest(s, [clientLine(s.hash, "boom 1")]);
    const list = data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO })));
    const fp = list.groups[0].fingerprint as string;
    const r = data(await errorsLoad(loaderCtx(s.d, `/apps/hello/client-errors?fp=${fp}`, { params: HELLO })));
    expect(r.detail.events).toHaveLength(1);
    expect(r.detail.events[0].request_url).toStartWith("/apps/hello/logs?q=01JBQ3Z7M8K5V6W9X2Y4A1B");
    expect(r.detail.events[0].frames[0]).toMatchObject({ function: "updateTotal", mapped: false });
    // A malformed fp is ignored, not sent to the API.
    const bad = data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors?fp=../x", { params: HELLO })));
    expect(bad.detail).toBeNull();
  });

  test("Resolve and Reopen go through the API and the status filter follows", async () => {
    const s = await setup();
    await ingest(s, [clientLine(s.hash, "boom 1")]);
    const fp = data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO }))).groups[0].fingerprint as string;
    const done = data(await errorsActions.status(actionCtx(s.d, "/apps/hello/client-errors", "status", { fingerprint: fp, status: "resolved" }, { params: HELLO })));
    expect(done.notice).toContain("resolved");
    expect(data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO }))).groups).toHaveLength(0);
    const resolved = data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors?status=resolved", { params: HELLO })));
    expect(resolved.groups[0]).toMatchObject({ status: "resolved", can_reopen: true, can_resolve: false });
    expect(data(await errorsActions.status(actionCtx(s.d, "/x", "status", { fingerprint: fp, status: "open" }, { params: HELLO }))).notice).toBe("Reopened.");
    expect(data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors?status=all", { params: HELLO }))).groups).toHaveLength(1);
  });

  test("a bad fingerprint or status is refused before the API; a token without apps:write gets the API's refusal", async () => {
    const s = await setup(["logs:read", "apps:read"]);
    await ingest(s, [clientLine(s.hash, "boom 1")]);
    const list = data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO })));
    expect(list.problem).toBeNull();
    const before = s.d.calls.sent.length;
    expect(data(await errorsActions.status(actionCtx(s.d, "/x", "status", { fingerprint: "nope", status: "resolved" }, { params: HELLO }))).action_problem.status).toBe(400);
    expect(data(await errorsActions.status(actionCtx(s.d, "/x", "status", { fingerprint: list.groups[0].fingerprint, status: "fixed" }, { params: HELLO }))).action_problem.status).toBe(400);
    expect(s.d.calls.sent.length).toBe(before);
    const refused = data(await errorsActions.status(actionCtx(s.d, "/x", "status", { fingerprint: list.groups[0].fingerprint, status: "resolved" }, { params: HELLO })));
    expect(refused.action_problem.status).toBe(403);
  });

  /** client-events.md section 7: the dashboard warns from 80 % of the daily cap. */
  test("the quota warning appears from 80 % of the daily cap", async () => {
    const s = await setup();
    expect(data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO }))).quota).toEqual({ used: "0", cap: "144,000", warning: false });
    logIngest(s.d.h.deps).clientToday.add("t_hello", 115_200, s.d.h.deps.now());
    expect(data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO }))).quota).toEqual({ used: "115,200", cap: "144,000", warning: true });
  });

  test("an API failure is rendered in the page, not thrown", async () => {
    const s = await setup(["apps:read"]);
    const r = data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO })));
    expect(r.problem.status).toBe(403);
    expect(r.groups).toEqual([]);
  });

  test("the Logs page links a client line to its group and not a server line", async () => {
    const s = await setup();
    await ingest(s, [clientLine(s.hash, "boom 1")]);
    const fp = data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO }))).groups[0].fingerprint as string;
    const lines = data(await logsLoad(loaderCtx(s.d, "/apps/hello/logs?source=client", { params: HELLO }))).lines as { group_url: string | null }[];
    expect(lines.map((l) => l.group_url)).toEqual([`/apps/hello/client-errors?fp=${fp}`]);
  });
});
