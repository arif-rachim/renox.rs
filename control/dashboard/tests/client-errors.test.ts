// The Browser errors page and its status action (#128, docs/19-platform-wireframes.md 3.5)
// against the real control API (in process): groups from ingested client
// lines, the original TypeScript position from a privately uploaded
// sourcemap, the 80 % quota warning, and the link from a client log line to
// its group. With RENOX_WORKER_PATH, the last test renders the Logs filter
// and the group view through the worker and screenshots them in Chromium.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, writeTar } from "@renox/artifact-validate";

import { helloArtifact, upload } from "../../api/tests/artifacts.ts";
import { logIngest } from "../../api/src/ingest/logs.ts";
import { assertScoped, createApp_, registeredNode, scopedToken, tenant } from "../../api/tests/helpers.ts";
import { load as errorsLoad, actions as errorsActions } from "../pages/apps/[app]/client-errors.ts";
import { load as logsLoad } from "../pages/apps/[app]/logs.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, dash, devWithData, loaderCtx, screenshots, type Dash } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);

const HELLO = { app: "hello" };
const worker = process.env.RENOX_WORKER_PATH;
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
type Frame = { file: string; line: number; column: number; function: string | null };
const clientLine = (hash: string, message: string, file = "/islands/cart.js", stack: Frame[] = [{ file, line: 1, column: 1, function: "updateTotal" }]) => {
  seq += 1;
  return {
    ts: Date.now() - 60_000 + seq,
    tenant_id: "t_hello",
    deployment_hash: hash,
    request_id: `01JBQ3Z7M8K5V6W9X2Y4A1B${String(seq).padStart(3, "0")}`,
    module: "client",
    level: "error",
    message: `js.error: ${message}`,
    fields: { source: "client", kind: "js.error", client_ts: 1, url: "/cart", ua: "chrome", session_fingerprint: "abcdefghijklmnop", detail: { message, stack } },
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

  /**
   * The screenshot test (#128 acceptance 1): the group view with its detail
   * and the Logs page filtered to `source: client`, rendered by the worker
   * from what the real loaders returned against the real API (tests/helpers.ts,
   * devWithData), then shot in Chromium when Playwright is installed. The map
   * is the committed fixture of control/api/test/fixtures/sourcemaps.
   */
  test.skipIf(!worker)(
    "rendered by the worker: the Logs source filter and the group view with the original TypeScript frame",
    async () => {
      const s = await setup();
      const fixture = join(import.meta.dir, "../../api/test/fixtures/sourcemaps");
      const map = readFileSync(join(fixture, "maps/public/scripts/cart.js.map"));
      await s.d.h.store.put(`sourcemaps/t_hello/${s.hash}.tar`, writeTar(new Map([["public/scripts/cart.js.map", new Uint8Array(map)]])));
      const built = readFileSync(join(fixture, "public/scripts/cart.js"), "utf8").split("\n");
      const line = built.findIndex((l) => l.includes(".toFixed(")) + 1;
      const column = (built[line - 1] as string).indexOf("toFixed") + 1;
      const mapped = clientLine(s.hash, "Cannot read properties of undefined (reading 'toFixed')", "/scripts/cart.js", [{ file: "/scripts/cart.js", line, column, function: "boom" }]);
      await ingest(s, [mapped, clientLine(s.hash, "boom 1")]);
      const list = data(await errorsLoad(loaderCtx(s.d, "/apps/hello/client-errors", { params: HELLO })));
      const fp = list.groups.find((g: Data) => g.top.mapped).fingerprint as string;
      const group = data(await errorsLoad(loaderCtx(s.d, `/apps/hello/client-errors?fp=${fp}`, { params: HELLO })));
      const logs = data(await logsLoad(loaderCtx(s.d, "/apps/hello/logs?source=client", { params: HELLO })));

      const dev = await devWithData({ "pages/apps/[app]/client-errors.ts": group, "pages/apps/[app]/logs.ts": logs });
      try {
        const errorsPage = await fetch(`${dev.base}/apps/hello/client-errors?fp=${fp}`);
        expect(errorsPage.status).toBe(200);
        // The renderer adds `dir="auto"` to text it prints; it is not what is checked here.
        const plain = (h: string) => h.replaceAll(' dir="auto"', "");
        const html = plain(await errorsPage.text());
        expect(html).toContain("<h1>Browser errors</h1>");
        expect(html).toMatch(/<a href="\?status=open" class="current">open<\/a>/u);
        // Two groups: the mapped one at its TypeScript position, the other marked unmapped.
        expect(html).toContain(`<code>scripts/cart.ts:13:`);
        expect(html).toContain("(no sourcemap)");
        // The detail: the frame's function, original position, and the browser's position beside it.
        expect(html).toContain("<code>boom</code> <code>scripts/cart.ts:13:");
        expect(html).toContain(`(browser: /scripts/cart.js:${line}:${column})`);
        expect(html).toContain(`href="/apps/hello/logs?q=${mapped.request_id}`);
        expect(html).not.toContain(".map");

        const logsPage = await fetch(`${dev.base}/apps/hello/logs?source=client`);
        expect(logsPage.status).toBe(200);
        const logsHtml = plain(await logsPage.text());
        const source = /<select name="source">([\s\S]*?)<\/select>/u.exec(logsHtml)?.[1] ?? "";
        expect(source.match(/<option value="(\w+)" selected/gu)).toEqual(['<option value="client" selected']);
        expect(logsHtml).toContain(`href="/apps/hello/client-errors?fp=${fp}"`);

        const out = process.env.RENOX_SCREENSHOTS ?? mkdtempSync(join(tmpdir(), "renox-dashboard-shots-"));
        mkdirSync(out, { recursive: true });
        const shots = await screenshots(dev.base, { "client-errors-group": `/apps/hello/client-errors?fp=${fp}`, "logs-source-client": "/apps/hello/logs?source=client" }, out);
        if (shots !== null) {
          // No console error, CSP violation or uncaught exception on either page.
          expect(shots.errors).toEqual([]);
          expect(shots.files).toHaveLength(2);
          for (const f of shots.files) expect(statSync(f).size).toBeGreaterThan(5_000);
        }
      } finally {
        await dev.stop();
      }
    },
    120_000,
  );
});
