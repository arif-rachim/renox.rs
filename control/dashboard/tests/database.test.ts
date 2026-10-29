// The Database screen (#258, docs/19-platform-wireframes.md 3.8) against the
// real control API (in process) with a fake node behind it: the header
// (size, quota, WAL, replication and lag), the generations of the Backups
// panel and its restore into a new app, and the Export panel's signed link.
// With RENOX_WORKER_PATH, the last test renders the page through the worker
// and screenshots it in Chromium.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { contentHash } from "@renox/artifact-validate";

import { setRawNodeCall } from "../../api/src/tenants/backups.ts";
import { setNodeCall } from "../../api/src/workers/failover.ts";
import { helloArtifact, upload } from "../../api/tests/artifacts.ts";
import { assertScoped, createApp_, nodeToken, scopedToken, tenant } from "../../api/tests/helpers.ts";
import { databaseView, parseLocal } from "../lib/database.ts";
import { load, actions } from "../pages/apps/[app]/database.ts";
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
const FILE = new TextEncoder().encode("SQLite format 3\u0000 pretend database bytes");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const HOUR = 3_600_000;

async function setup(scopes?: string[]): Promise<{ d: Dash; restores: unknown[]; now: number }> {
  const d = await dash();
  const node = await nodeToken(d.h, "node-1");
  const reg = await d.h.request("POST", "/v1/nodes/register", {
    token: node,
    json: { type: "node_register", schema_version: 0, node_id: "node-1", worker_version: "0.3.0", region: "me-central-1", max_cells: 100, listen_url: "http://10.0.0.10:8790" },
  });
  expect(reg.status).toBe(200);
  const owner = await tenant(d.h, "t_hello");
  await createApp_(d.h, owner, "hello");
  const files = helloArtifact();
  expect((await upload(d.h, owner, "hello", files)).status).toBe(201);
  expect((await d.h.request("POST", "/v1/apps/hello/activate", { token: owner, json: { hash: contentHash(files) } })).status).toBe(200);
  const now = d.h.clock.now;
  const restores: unknown[] = [];
  setNodeCall(d.h.deps, async (target, method, _path, body) => {
    if (method === "GET") {
      return {
        status: 200,
        body: {
          type: "replication_status", schema_version: 0, node_id: target.node_id, tenant_id: "t_hello", database: "t_hello", replication: "litestream", state: "replicating",
          replica: { kind: "s3", region: "me-central-1" }, last_sync_at: now - 1000, lag_seconds: 0.5, retention_hours: 24, snapshot_interval_seconds: 3600,
          generations: [{ id: "0123456789abcdef", start: now - 30 * HOUR, end: now - 20 * HOUR }, { id: "a1b2c3d4e5f60718", start: now - 20 * HOUR, end: now }],
          db: { size_bytes: 10 * 1024 * 1024, quota_bytes: 0, wal_bytes: 4096 },
        },
      };
    }
    const req = body as { timestamp: number; database: string };
    restores.push(body);
    return { status: 200, body: { type: "restore_result", schema_version: 0, node_id: "node-1", tenant_id: "t_hello", database: req.database, source: "replica", generation: "a1b2c3d4e5f60718", file_sha256: "0".repeat(64), restored_to: req.timestamp, elapsed_ms: 900 } };
  });
  setRawNodeCall(d.h.deps, async (_node, method, path) => {
    if (method === "POST" && path.includes("/snapshot")) return new Response(FILE, { headers: { "x-renox-sha256": sha(FILE) } });
    return new Response(null, { status: 404 });
  });
  const token = scopes === undefined ? owner : await scopedToken(d.h, "t_hello", scopes);
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token, next: "/apps" }))).toBeInstanceOf(Response);
  return { d, restores, now };
}

describe("Database (3.8)", () => {
  test("the header shows size, quota, WAL, replication and lag; the Backups panel lists the generations, newest first", async () => {
    const { d, now } = await setup();
    const page = data(await load(loaderCtx(d, "/apps/hello/database", { params: HELLO })));
    expect(page.problem).toBeNull();
    expect(page.view).toMatchObject({ database: "t_hello", size: "10.0 MB", quota: "100.0 MB", pct: 10, wal: "4.0 KB", replicating: true, stale: false, retention: "24 h" });
    expect(page.view.replication).toBe("Litestream to s3 (me-central-1): replicating");
    expect(page.view.sync).toContain("lag 0.5 s");
    expect(page.view.generations.map((g: Data) => g.id)).toEqual(["a1b2c3d4e5f60718", "0123456789abcdef"]);
    expect(page.view.latest).toBe(new Date(now).toISOString().slice(0, 19));
    // Only the API was called, with the user's own token.
    expect(new Set(d.calls.sent.map((c) => new URL(c.url).origin))).toEqual(new Set(["https://api.renox.app"]));
  });

  test("export answers a signed link the browser downloads; the dashboard never fetched the bytes", async () => {
    const { d } = await setup();
    const r = data(await actions.export(actionCtx(d, "/apps/hello/database", "export", {}, { params: HELLO })));
    expect(r.action_problem).toBeNull();
    expect(r.download).toMatchObject({ sha256: sha(FILE), size: `${FILE.length} B` });
    const url = new URL(r.download.url);
    expect(url.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/u);
    expect(r.download.file).toMatch(/^hello-\d{8}T\d{6}\.db$/u);
    expect(d.calls.sent.filter((c) => c.url.includes("/v1/exports/"))).toEqual([]);
  });

  test("restore into a new app links to it; a bad name or time is refused before the API; apps:read cannot restore", async () => {
    const { d, restores, now } = await setup();
    const at = new Date(now - 2 * HOUR).toISOString().slice(0, 19);
    const r = data(await actions.restore(actionCtx(d, "/apps/hello/database", "restore", { at, name: "hello-old" }, { params: HELLO })));
    expect(r.action_problem).toBeNull();
    expect(r.restored).toEqual({ name: "hello-old", href: "/apps/hello-old" });
    expect(r.notice).toContain("into hello-old");
    expect(restores.at(-1)).toMatchObject({ timestamp: parseLocal(at), database: "t_hello.hello-old" });
    const sent = d.calls.sent.length;
    for (const fields of [{ at, name: "Bad_Name" }, { at, name: "hello" }, { at: "yesterday", name: "x-1" }]) {
      expect(data(await actions.restore(actionCtx(d, "/apps/hello/database", "restore", fields, { params: HELLO }))).form_error).not.toBeNull();
    }
    expect(d.calls.sent.length).toBe(sent);

    const ro = await setup(["apps:read"]);
    const denied = data(await actions.restore(actionCtx(ro.d, "/apps/hello/database", "restore", { at, name: "hello-ro" }, { params: HELLO })));
    expect(denied.action_problem.status).toBe(403);
  });

  test("view rules: no replica, a stale status, no generations", () => {
    const v = databaseView(
      { app: "a", database: "t", replication: "none", state: "off", replica: null, last_sync_at: null, lag_seconds: null, retention_hours: 0, generations: [], db: { size_bytes: 0, quota_bytes: 0, wal_bytes: 0 }, last_failover: null, stale: true },
      0,
    );
    expect(v).toMatchObject({ replicating: false, sync: null, stale: true, latest: null, retention: "—", pct: 0 });
    expect(parseLocal("2026-10-30T00:00")).toBe(Date.UTC(2026, 9, 30));
    expect(parseLocal("2026-10-30")).toBeNull();
  });

  test.skipIf(!worker)(
    "rendered by the worker: the header, the generations and both panels",
    async () => {
      const { d } = await setup();
      const page = data(await load(loaderCtx(d, "/apps/hello/database", { params: HELLO })));
      const dev = await devWithData({ "pages/apps/[app]/database.ts": page });
      try {
        const res = await fetch(`${dev.base}/apps/hello/database`);
        expect(res.status).toBe(200);
        const html = (await res.text()).replaceAll(' dir="auto"', "");
        expect(html).toContain("<h1>Database</h1>");
        expect(html).toContain("Litestream to s3 (me-central-1): replicating");
        expect(html).toContain("<code>a1b2c3d4e5f60718</code>");
        expect(html).toContain("Restore to new app");
        expect(html).toContain("Prepare .db download");
        expect(html).toMatch(/href="\/apps\/hello\/database" class="current"/u);
        const out = process.env.RENOX_SCREENSHOTS ?? mkdtempSync(join(tmpdir(), "renox-dashboard-shots-"));
        mkdirSync(out, { recursive: true });
        const shots = await screenshots(dev.base, { database: "/apps/hello/database" }, out);
        if (shots !== null) {
          expect(shots.errors).toEqual([]);
          for (const f of shots.files) expect(statSync(f).size).toBeGreaterThan(5_000);
        }
      } finally {
        await dev.stop();
      }
    },
    120_000,
  );
});
