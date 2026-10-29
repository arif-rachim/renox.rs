// Browser errors in the tenant's logs (#128; deploy-api.md section 11.1):
// grouping at ingestion, regression, private sourcemaps and symbolication,
// the daily client-event quota, and the three client-error endpoints.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, writeTar } from "@renox/artifact-validate";
import { fingerprintOf, framesOf, messageTemplate, normalizeFile } from "../src/logs/grouping.ts";
import { logIngest } from "../src/ingest/logs.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, createApp_, type Harness, harness, registeredNode, scopedToken, tenant } from "./helpers.ts";

afterEach(assertScoped);

let seq = 0;
interface Frame {
  file: string;
  line?: number;
  column?: number;
  function?: string | null;
}
/** A `source: client` log line as the gateway writes it (client-events.md section 9). */
const clientLine = (hash: string, message: string, frames: Frame[] = [], over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    ts: 1_793_318_400_000 + seq,
    tenant_id: "t_hello",
    deployment_hash: hash,
    request_id: `01JBQ3Z7M8K5V6W9X2Y4A1B${String(seq).padStart(3, "0")}`,
    module: "client",
    level: "error",
    message: `js.error: ${message}`,
    fields: { source: "client", kind: "js.error", client_ts: 1_793_318_399_900 + seq, url: "/cart", ua: "chrome", session_fingerprint: "abcdefghijklmnop", detail: { message, stack: frames } },
    source: "client",
    ...over,
  };
};
const batch = (lines: unknown[]) => ({ type: "log_batch", schema_version: 0, node_id: "node-1", lines });

interface Setup {
  h: Harness;
  token: string;
  node: string;
  hash: string;
}

async function setup(): Promise<Setup> {
  const h = await harness();
  const token = await tenant(h, "t_hello");
  await createApp_(h, token, "hello");
  const files = variant(1);
  expect((await upload(h, token, "hello", files)).status).toBe(201);
  return { h, token, node: await registeredNode(h, "node-1"), hash: contentHash(files) };
}

const variant = (n: number) => helloArtifact((_m, f) => f.set("code/n.json", new TextEncoder().encode(String(n))));

/** A second deployment of the app, created a minute later. */
async function second(s: Setup): Promise<string> {
  s.h.clock.now += 60_000;
  const files = variant(2);
  expect((await upload(s.h, s.token, "hello", files)).status).toBe(201);
  return contentHash(files);
}

const ingest = async (s: Setup, lines: unknown[]) => {
  const res = await s.h.request("POST", "/v1/ingest/logs", { token: s.node, json: batch(lines) });
  expect(res.status).toBe(202);
};
const list = async (s: Setup, qs = ""): Promise<{ groups: Record<string, any>[]; next_cursor: string | null }> => (await s.h.request("GET", `/v1/apps/hello/client-errors${qs}`, { token: s.token })).json() as never;
const detail = async (s: Setup, fp: string): Promise<{ group: Record<string, any>; events: Record<string, any>[] }> => (await s.h.request("GET", `/v1/apps/hello/client-errors/${fp}`, { token: s.token })).json() as never;
const setStatus = (s: Setup, fp: string, status: string) => s.h.request("POST", `/v1/apps/hello/client-errors/${fp}`, { token: s.token, json: { status } });

describe("fingerprints", () => {
  test("numbers, ids and content hashes do not split a group; kind, frame and wording do", () => {
    expect(messageTemplate("js.error: Order 1234 failed for 3f9a1c5e7b2d4086", "js.error")).toBe("Order <n> failed for <id>");
    expect(messageTemplate("user 550e8400-e29b-41d4-a716-446655440000 not found", "js.error")).toBe("user <id> not found");
    expect(normalizeFile("/assets/app.3f9a1c2b.js?v=3")).toBe("/assets/app.js");
    expect(normalizeFile("/islands/cart.js")).toBe("/islands/cart.js");
    const f = (message: string, file = "/a.js") => {
      const line = clientLine("a".repeat(64), message, [{ file, line: 1, column: 1, function: "x" }]);
      return fingerprintOf("js.error", line, framesOf(line));
    };
    expect(f("boom 1")).toBe(f("boom 22"));
    expect(f("boom")).not.toBe(f("bang"));
    expect(f("boom", "/b.js")).not.toBe(f("boom"));
    expect(f("boom")).toMatch(/^[0-9a-f]{16}$/u);
  });
});

describe("ingestion", () => {
  test("a batch produces groups: the same error twice is one group with count 2; another error is another group", async () => {
    const s = await setup();
    const top = { file: "/islands/cart.js", line: 1, column: 20, function: "updateTotal" };
    await ingest(s, [clientLine(s.hash, "boom 1", [top]), clientLine(s.hash, "boom 2", [top]), clientLine(s.hash, "other", [{ ...top, function: "other" }])]);
    const { groups } = await list(s);
    expect(groups.map((g) => g.count).sort()).toEqual([1, 2]);
    const two = groups.find((g) => g.count === 2) as Record<string, any>;
    expect(two).toMatchObject({ kind: "js.error", status: "open", regressed: false, deployments: [{ deployment_hash: s.hash, count: 2 }], top_frame: { file: "/islands/cart.js", function: "updateTotal", original: null } });
    expect(two.first_seen).toBeLessThan(two.last_seen);
    expect((await detail(s, two.fingerprint)).events).toHaveLength(2);
  });

  test("the same error on a new deployment increments the group and adds a deployment row, newest first", async () => {
    const s = await setup();
    const top = { file: "/a.js", line: 1, column: 1, function: "f" };
    await ingest(s, [clientLine(s.hash, "boom", [top])]);
    const hash2 = await second(s);
    await ingest(s, [clientLine(hash2, "boom", [top])]);
    const { groups } = await list(s);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 2, deployments: [{ deployment_hash: hash2, count: 1 }, { deployment_hash: s.hash, count: 1 }] });
    expect((await list(s, `?deployment=${hash2}`)).groups).toHaveLength(1);
    expect((await list(s, `?deployment=${"0".repeat(64)}`)).groups).toHaveLength(0);
  });

  test("only the last 20 events of a group are kept, but the count is complete", async () => {
    const s = await setup();
    const top = { file: "/a.js", line: 1, column: 1, function: "f" };
    await ingest(s, Array.from({ length: 25 }, (_, i) => clientLine(s.hash, `boom ${i}`, [top])));
    const fp = (await list(s)).groups[0]?.fingerprint as string;
    const d = await detail(s, fp);
    expect(d.group.count).toBe(25);
    expect(d.events).toHaveLength(20);
    expect(d.events[0]?.ts).toBeGreaterThan(d.events[19]?.ts);
  });

  test("a line of kind without a stack (htmx) groups by its target; a server line is not an event", async () => {
    const s = await setup();
    const htmx = (target: string) => clientLine(s.hash, "x", [], { message: "htmx.targetError", fields: { source: "client", kind: "htmx.targetError", client_ts: 1, url: "/", ua: "firefox", session_fingerprint: "abcdefghijklmnop", detail: { target } } });
    await ingest(s, [htmx("#a"), htmx("#a"), htmx("#b"), { ...clientLine(s.hash, "n/a"), source: "server", fields: null }]);
    expect((await list(s)).groups.map((g) => g.count).sort()).toEqual([1, 2]);
  });

  /** docs/24-threat-model.md E, IDOR row. */
  test("another tenant sees none of the groups and gets 404 on a fingerprint of this tenant", async () => {
    const s = await setup();
    await ingest(s, [clientLine(s.hash, "boom", [{ file: "/a.js" }])]);
    const fp = (await list(s)).groups[0]?.fingerprint as string;
    const other = await tenant(s.h, "t_other");
    await createApp_(s.h, other, "other");
    expect((await s.h.request("GET", `/v1/apps/hello/client-errors/${fp}`, { token: other })).status).toBe(404);
    expect((await s.h.request("GET", "/v1/apps/hello/client-errors", { token: other })).status).toBe(404);
    expect((await s.h.request("POST", `/v1/apps/hello/client-errors/${fp}`, { token: other, json: { status: "ignored" } })).status).toBe(404);
    const own = await s.h.request("GET", "/v1/apps/other/client-errors/" + fp, { token: other });
    expect(own.status).toBe(404);
  });
});

describe("status and regression", () => {
  const top = { file: "/a.js", line: 1, column: 1, function: "f" };

  test("resolve, ignore and reopen by hand; the same status twice is a no-op", async () => {
    const s = await setup();
    await ingest(s, [clientLine(s.hash, "boom", [top])]);
    const fp = (await list(s)).groups[0]?.fingerprint as string;
    for (const status of ["resolved", "resolved", "ignored", "open"]) {
      const res = await setStatus(s, fp, status);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe(status);
    }
    expect((await list(s, "?status=open")).groups).toHaveLength(1);
    expect((await list(s, "?status=resolved")).groups).toHaveLength(0);
    expect((await setStatus(s, fp, "fixed")).status).toBe(400);
    expect((await s.h.request("POST", `/v1/apps/hello/client-errors/${fp}`, { token: s.token, json: { status: "open", note: "x" } })).status).toBe(400);
    expect((await setStatus(s, "0".repeat(16), "open")).status).toBe(404);
    expect((await setStatus(s, "XYZ", "open")).status).toBe(404);
  });

  test("a resolved group stays resolved on the same deployment and reopens as a regression on a newer one", async () => {
    const s = await setup();
    // Activate the first deployment so "resolved on deployment A" is defined.
    expect((await s.h.request("POST", "/v1/apps/hello/activate", { token: s.token, json: { hash: s.hash } })).status).toBe(200);
    await ingest(s, [clientLine(s.hash, "boom 6", [top])]);
    const fp = (await list(s)).groups[0]?.fingerprint as string;
    await setStatus(s, fp, "resolved");
    await ingest(s, [clientLine(s.hash, "boom 7", [top])]);
    expect((await list(s)).groups[0]).toMatchObject({ status: "resolved", regressed: false, count: 2 });
    const hash2 = await second(s);
    await ingest(s, [clientLine(hash2, "boom 8", [top])]);
    expect((await list(s)).groups[0]).toMatchObject({ status: "open", regressed: true, count: 3 });
    // Setting a status by hand clears the flag.
    await setStatus(s, fp, "open");
    expect((await list(s)).groups[0]).toMatchObject({ regressed: false });
  });

  test("an ignored group keeps counting and stays ignored", async () => {
    const s = await setup();
    await ingest(s, [clientLine(s.hash, "boom", [top])]);
    const fp = (await list(s)).groups[0]?.fingerprint as string;
    await setStatus(s, fp, "ignored");
    await ingest(s, [clientLine(s.hash, "boom", [top])]);
    expect((await list(s)).groups[0]).toMatchObject({ status: "ignored", count: 2 });
  });

  test("a token without apps:write cannot change a status (403); logs:read can list and read", async () => {
    const s = await setup();
    await ingest(s, [clientLine(s.hash, "boom", [top])]);
    const fp = (await list(s)).groups[0]?.fingerprint as string;
    const reader = await scopedToken(s.h, "t_hello", ["logs:read"]);
    expect((await s.h.request("GET", "/v1/apps/hello/client-errors", { token: reader })).status).toBe(200);
    expect((await s.h.request("GET", `/v1/apps/hello/client-errors/${fp}`, { token: reader })).status).toBe(200);
    expect((await s.h.request("POST", `/v1/apps/hello/client-errors/${fp}`, { token: reader, json: { status: "ignored" } })).status).toBe(403);
    expect((await s.h.request("GET", "/v1/apps/hello/client-errors")).status).toBe(401);
  });

  test("paging: limit and next_cursor walk all groups once", async () => {
    const s = await setup();
    await ingest(s, Array.from({ length: 5 }, (_, i) => clientLine(s.hash, `boom ${i}`, [{ file: `/f${i}.js`, line: 1, column: 1, function: "f" }])));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(s, `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      seen.push(...page.groups.map((g) => g.fingerprint as string));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect((await s.h.request("GET", "/v1/apps/hello/client-errors?limit=0", { token: s.token })).status).toBe(400);
    expect((await s.h.request("GET", "/v1/apps/hello/client-errors?cursor=x", { token: s.token })).status).toBe(400);
  });
});

describe("sourcemaps", () => {
  /** Builds islands/cart.ts with the real bundler, as `renox build` does for server code; returns the generated code and its map under public/. */
  async function built(): Promise<{ files: Map<string, Uint8Array>; line: number; column: number; sourceLine: number }> {
    const dir = mkdtempSync(join(tmpdir(), "renox-island-"));
    mkdirSync(join(dir, "islands"));
    const src = ["export function total(items: { price: number }[]): number {", "  return items.reduce((n, i) => n + i.price, 0);", "}", "", "export function boom(cart: { total?: number }): string {", "  return cart.total!.toFixed(2); // line 6", "}", ""].join("\n");
    writeFileSync(join(dir, "islands/cart.ts"), src);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = await Bun.build({ entrypoints: ["islands/cart.ts"], root: ".", target: "browser", format: "esm", sourcemap: "external", naming: "[dir]/[name].[ext]" });
      expect(r.success).toBe(true);
      const files = new Map<string, Uint8Array>();
      let code = "";
      for (const o of r.outputs) {
        const text = await o.text();
        if (o.kind === "sourcemap") files.set(`public/islands/cart.js.map`, new TextEncoder().encode(text));
        else code = text;
      }
      const lines = code.split("\n");
      const line = lines.findIndex((l) => l.includes("toFixed")) + 1;
      return { files, line, column: (lines[line - 1] as string).indexOf("toFixed") + 1, sourceLine: 6 };
    } finally {
      process.chdir(cwd);
    }
  }

  test("a frame is mapped to the TypeScript source line when the deployment's map was uploaded privately", async () => {
    const s = await setup();
    const b = await built();
    const put = await s.h.request("PUT", `/v1/apps/hello/deployments/${s.hash}/sourcemaps`, { token: s.token, body: writeTar(b.files), headers: { "content-type": "application/x-tar" } });
    expect(put.status).toBe(204);
    await ingest(s, [clientLine(s.hash, "Cannot read properties of undefined", [{ file: "/islands/cart.js", line: b.line, column: b.column, function: "boom" }, { file: "https://cdn.example/lib.js", line: 1, column: 1 }])]);
    const fp = (await list(s)).groups[0]?.fingerprint as string;
    const d = await detail(s, fp);
    expect(d.group.top_frame).toMatchObject({ file: "/islands/cart.js", line: b.line, original: { file: "islands/cart.ts", line: b.sourceLine } });
    expect(d.events[0]?.frames[0].original).toMatchObject({ file: "islands/cart.ts", line: b.sourceLine });
    // A cross-origin frame and a frame no map covers keep their raw position and a null original.
    expect(d.events[0]?.frames[1]).toMatchObject({ file: "https://cdn.example/lib.js", original: null });
    expect((await list(s)).groups[0]?.top_frame.original).toMatchObject({ file: "islands/cart.ts", line: b.sourceLine });
  });

  /** The original path never leaks the build machine's layout. */
  test("a map that records absolute or parent-relative sources shows a relative path", async () => {
    const s = await setup();
    const map = { version: 3, sources: ["/home/ci/work/app/../app/islands/cart.ts"], names: [], mappings: "AAAA" };
    const files = new Map([["public/x.js.map", new TextEncoder().encode(JSON.stringify(map))]]);
    await s.h.request("PUT", `/v1/apps/hello/deployments/${s.hash}/sourcemaps`, { token: s.token, body: writeTar(files), headers: { "content-type": "application/x-tar" } });
    await ingest(s, [clientLine(s.hash, "boom", [{ file: "/x.js", line: 1, column: 1 }])]);
    const fp = (await list(s)).groups[0]?.fingerprint as string;
    expect((await detail(s, fp)).group.top_frame.original).toEqual({ file: "home/ci/work/app/islands/cart.ts", line: 1, column: 1 });
  });

  /** Sourcemaps are never reachable: no route of the API serves them, and they are not in the artifact. */
  test("sourcemaps are not served by any route and are not part of the stored artifact", async () => {
    const s = await setup();
    const b = await built();
    await s.h.request("PUT", `/v1/apps/hello/deployments/${s.hash}/sourcemaps`, { token: s.token, body: writeTar(b.files), headers: { "content-type": "application/x-tar" } });
    for (const path of [`/v1/apps/hello/deployments/${s.hash}/sourcemaps`, "/public/islands/cart.js.map", `/v1/nodes/node-1/sourcemaps/${s.hash}`]) {
      expect((await s.h.request("GET", path, { token: s.token })).status).toBe(404);
    }
    const keys = [...s.h.store.objects.keys()];
    expect(keys.filter((k) => k.includes("sourcemaps"))).toHaveLength(1);
    expect(keys.filter((k) => !k.startsWith("sourcemaps/") && k.endsWith(".map"))).toEqual([]);
  });
});

describe("the daily client-event quota", () => {
  const usage = async (s: Setup) => ((await (await s.h.request("GET", "/v1/apps/hello/usage", { token: s.token })).json()) as { client_events: { used_today: number; daily_cap: number; warning: boolean } }).client_events;

  /** client-events.md section 7: a warning from 80 % of the daily cap (144,000 free). */
  test("the usage view reports used_today and warns from 80 % of the cap", async () => {
    const s = await setup();
    expect(await usage(s)).toEqual({ used_today: 0, daily_cap: 144_000, warning: false });
    const { clientToday } = logIngest(s.h.deps);
    clientToday.add("t_hello", 115_199, s.h.deps.now());
    expect(await usage(s)).toEqual({ used_today: 115_199, daily_cap: 144_000, warning: false });
    await ingest(s, [clientLine(s.hash, "boom", [{ file: "/a.js" }])]);
    expect(await usage(s)).toEqual({ used_today: 115_200, daily_cap: 144_000, warning: true });
    await s.h.db.query("update tenants set tier = 'paid' where id = 't_hello'");
    expect(await usage(s)).toEqual({ used_today: 115_200, daily_cap: 1_440_000, warning: false });
  });

  test("the count stops at the cap (the gateway drops the rest)", async () => {
    const s = await setup();
    logIngest(s.h.deps).clientToday.add("t_hello", 200_000, s.h.deps.now());
    expect(await usage(s)).toEqual({ used_today: 144_000, daily_cap: 144_000, warning: true });
  });
});

describe("the Logs link", () => {
  test("a stored client line carries fields.fingerprint, the key of its group, and streamLogs serves it", async () => {
    const s = await setup();
    await ingest(s, [clientLine(s.hash, "boom 1", [{ file: "/a.js", line: 1, column: 1, function: "f" }])]);
    const fp = (await list(s)).groups[0]?.fingerprint as string;
    const text = await (await s.h.request("GET", "/v1/apps/hello/logs?source=client", { token: s.token })).text();
    const line = JSON.parse(/^data: (.*)$/mu.exec(text)?.[1] as string) as { fields: Record<string, unknown> };
    expect(line.fields).toMatchObject({ kind: "js.error", fingerprint: fp });
  });
});
