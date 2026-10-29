// renox db export | import | restore (#258) against a fake control plane
// (docs/contracts/deploy-api.md 0.3 section 14).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentHash } from "@renox/artifact-validate";

import { setRawNodeCall } from "../../control/api/src/tenants/backups.ts";
import { setNodeCall } from "../../control/api/src/workers/failover.ts";
import { helloArtifact, upload } from "../../control/api/tests/artifacts.ts";
import { createApp_, harness, nodeToken, tenant } from "../../control/api/tests/helpers.ts";
import type { Io } from "../src/commands/login.ts";
import { parseAt, run as db } from "../src/commands/db.ts";
import { CliError, EXIT } from "../src/errors.ts";

const TOKEN = `renox_pat_${"a".repeat(32)}`;
const API = "https://api.test";
const SIGNED = "https://exports.test/v1/exports/01JBQ3Z7MA0000000000000020?expires=1793318700000&sig=" + "f".repeat(64);
const FILE = new TextEncoder().encode("SQLite format 3\u0000 pretend database bytes");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array | null;
}

function fake(answer: (c: Call) => Response | undefined): Io & { lines: string[]; calls: Call[] } {
  const lines: string[] = [];
  const calls: Call[] = [];
  return {
    lines,
    calls,
    env: { RENOX_TOKEN: TOKEN, RENOX_API_URL: API, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")) },
    out: (l) => lines.push(l),
    sleep: async () => {},
    readStdin: async () => "",
    fetch: async (url, init) => {
      const raw = init?.body;
      const body = raw === undefined || raw === null ? null : typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw as Uint8Array);
      const call = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body };
      calls.push(call);
      const r = answer(call);
      if (r === undefined) throw new Error(`unexpected ${call.method} ${url}`);
      return r;
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const exported = (digest: string) => ({ url: SIGNED, expires_at: 1793318700000, created_at: 1793318400000, size_bytes: FILE.length, sha256: digest, masking: "none" });

async function failure(p: Promise<unknown>): Promise<CliError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CliError);
  return e as CliError;
}

describe("renox db export", () => {
  test("downloads through the signed URL without the API token, checks the sha256 and writes the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-db-"));
    const t = fake((c) => {
      if (c.url === `${API}/v1/apps/shop/backups/export`) return json(201, exported(sha(FILE)));
      if (c.url === SIGNED) return new Response(FILE);
      return undefined;
    });
    expect(await db(["export", "--app", "shop", "--out", "shop.db"], t, dir)).toBe(EXIT.OK);
    expect(t.calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", `${API}/v1/apps/shop/backups/export`],
      ["GET", SIGNED],
    ]);
    expect(t.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(t.calls[1]?.headers.get("authorization")).toBeNull();
    expect(new Uint8Array(readFileSync(join(dir, "shop.db")))).toEqual(FILE);
    expect(t.lines[0]).toContain(`sha256 ${sha(FILE)}`);
  });

  test("the default file name carries the app and the export time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-db-"));
    const t = fake((c) => (c.url === SIGNED ? new Response(FILE) : json(201, exported(sha(FILE)))));
    expect(await db(["export", "--app", "shop"], t, dir)).toBe(EXIT.OK);
    expect(readdirSync(dir)).toEqual(["shop-20261030T000000Z.db"]);
  });

  test("a sha256 mismatch is an error and leaves no file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-db-"));
    const t = fake((c) => (c.url === SIGNED ? new Response(FILE) : json(201, exported("0".repeat(64)))));
    const e = await failure(db(["export", "--app", "shop", "--out", "shop.db"], t, dir));
    expect(e.exitCode).toBe(EXIT.ENVIRONMENT);
    expect(e.message).toContain("does not match");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("an expired URL (403) is an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-db-"));
    const t = fake((c) => (c.url === SIGNED ? new Response(null, { status: 403 }) : json(201, exported(sha(FILE)))));
    expect((await failure(db(["export", "--app", "shop", "--out", "x.db"], t, dir))).exitCode).toBe(EXIT.ENVIRONMENT);
    expect(existsSync(join(dir, "x.db"))).toBe(false);
  });
});

describe("renox db import", () => {
  test("sends the file as application/vnd.sqlite3; the API's refusal of a production app is a user error with its reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-db-"));
    writeFileSync(join(dir, "seed.db"), FILE);
    const t = fake((c) => {
      if (c.url === `${API}/v1/apps/shop-staging/db/import`) return json(200, { app: "shop-staging", database: "t_bk.shop-staging", size_bytes: FILE.length, sha256: sha(FILE), tables: ["app__notes"] });
      if (c.url === `${API}/v1/apps/shop/db/import`) return json(422, { error: { code: "RENOX_IMPORT_REJECTED", message: "The import was refused.", request_id: "x", details: [{ field: "app", reason: "not a staging app" }] } });
      return undefined;
    });
    expect(await db(["import", "seed.db", "--app", "shop-staging"], t, dir)).toBe(EXIT.OK);
    expect(t.calls[0]?.headers.get("content-type")).toBe("application/vnd.sqlite3");
    expect(t.calls[0]?.body).toEqual(FILE);
    expect(t.lines[0]).toContain("app__notes");
    const e = await failure(db(["import", "seed.db", "--app", "shop"], t, dir));
    expect(e.exitCode).toBe(EXIT.USER);
    expect(`${e.message} ${e.hint ?? ""}`).toContain("not a staging app");
  });

  test("a file that is not SQLite, or missing, is refused before anything is sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-db-"));
    writeFileSync(join(dir, "notes.txt"), "hello");
    const t = fake(() => undefined);
    for (const args of [["import", "notes.txt"], ["import", "missing.db"], ["import"]]) expect((await failure(db([...args, "--app", "shop-staging"], t, dir))).exitCode).toBe(EXIT.USER);
    expect(t.calls).toEqual([]);
  });
});

describe("renox db restore", () => {
  test("asks for a restore into a new app at the given time", async () => {
    const t = fake((c) =>
      c.url === `${API}/v1/apps/shop/backups/restore`
        ? json(201, { app: { name: "shop-old", hostnames: ["shop-old.renox.app"] }, deployment: { hash: "a".repeat(64), state: "active" }, source_app: "shop", database: "t_bk.shop-old", generation: "a1b2c3d4e5f60718", restored_to: 1793318400000 })
        : undefined,
    );
    expect(await db(["restore", "--at", "2026-10-30T00:00:00Z", "--as", "shop-old", "--app", "shop"], t)).toBe(EXIT.OK);
    expect(JSON.parse(new TextDecoder().decode(t.calls[0]?.body ?? new Uint8Array()))).toEqual({ timestamp: 1793318400000, target: "new_app", name: "shop-old" });
    expect(t.lines[0]).toContain("https://shop-old.renox.app");
  });

  test("an unknown restore point is a user error; bad arguments send nothing", async () => {
    const t = fake(() => json(422, { error: { code: "RENOX_RESTORE_POINT_UNKNOWN", message: "No generation covers that time.", request_id: "x" } }));
    expect((await failure(db(["restore", "--at", "10", "--as", "shop-old", "--app", "shop"], t))).exitCode).toBe(EXIT.USER);
    const quiet = fake(() => undefined);
    for (const args of [["restore", "--as", "x"], ["restore", "--at", "1"], ["restore", "--at", "yesterday", "--as", "x"], ["restore", "--at", "2026-10-30T00:00:00", "--as", "x"], ["restore", "--at", "1", "--as", "Bad_Name"], ["export", "--at", "1"], ["frobnicate"], []]) {
      expect((await failure(db([...args, "--app", "shop"], quiet))).exitCode).toBe(EXIT.USER);
    }
    expect(quiet.calls).toEqual([]);
    expect(parseAt("1793318400000")).toBe(1793318400000);
    expect(parseAt("2026-10-30T04:00:00+04:00")).toBe(1793318400000);
  });
});

describe("renox db against the in-process control API", () => {
  test("export, import into a staging app, restore into a new app; a production import is refused", async () => {
    const h = await harness();
    const node = await nodeToken(h, "node-1");
    const reg = await h.request("POST", "/v1/nodes/register", {
      token: node,
      json: { type: "node_register", schema_version: 0, node_id: "node-1", worker_version: "0.3.0", region: "me-central-1", max_cells: 100, listen_url: "http://10.0.0.10:8790" },
    });
    expect(reg.status).toBe(200);
    const token = await tenant(h, "t_cli");
    await createApp_(h, token, "shop");
    const files = helloArtifact((m) => ((m.app as Record<string, string>).name = "shop"));
    await upload(h, token, "shop", files);
    expect((await h.request("POST", "/v1/apps/shop/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "shop-staging", staging: true } })).status).toBe(201);
    // The node: a snapshot of FILE, an import that answers what it got, a restore that succeeds.
    setRawNodeCall(h.deps, async (_node, method, path, body) => {
      if (method === "POST" && path.includes("/snapshot")) return new Response(FILE, { headers: { "x-renox-sha256": sha(FILE) } });
      if (method === "PUT" && path.includes("/import")) return Response.json({ type: "import_result", schema_version: 0, node_id: "node-1", tenant_id: "t_cli", database: "t_cli.shop-staging", size_bytes: body?.length ?? 0, sha256: sha(body ?? new Uint8Array()), tables: ["app__notes"] });
      return new Response(null, { status: 404 });
    });
    setNodeCall(h.deps, async (_target, _method, _path, body) => {
      const req = body as { timestamp: number; database: string };
      return { status: 200, body: { type: "restore_result", schema_version: 0, node_id: "node-1", tenant_id: "t_cli", database: req.database, source: "replica", generation: "a1b2c3d4e5f60718", file_sha256: "0".repeat(64), restored_to: req.timestamp, elapsed_ms: 900 } };
    });
    // Every URL, the API's and the signed one, reaches the harness by its path.
    const lines: string[] = [];
    const io: Io = {
      env: { RENOX_TOKEN: token, RENOX_API_URL: API, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")) },
      out: (l) => lines.push(l),
      sleep: async () => {},
      readStdin: async () => "",
      fetch: async (url, init) => {
        const u = new URL(url);
        const headers = Object.fromEntries(new Headers(init?.headers));
        return h.request(init?.method ?? "GET", `${u.pathname}${u.search}`, { headers, ...(init?.body === undefined ? {} : { body: init.body as BodyInit }) });
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "renox-db-"));
    expect(await db(["export", "--app", "shop", "--out", "shop.db"], io, dir)).toBe(EXIT.OK);
    expect(new Uint8Array(readFileSync(join(dir, "shop.db")))).toEqual(FILE);
    expect(await db(["import", "shop.db", "--app", "shop-staging"], io, dir)).toBe(EXIT.OK);
    expect(lines.at(-1)).toContain("app__notes");
    const refused = await failure(db(["import", "shop.db", "--app", "shop"], io, dir));
    expect(refused.exitCode).toBe(EXIT.USER);
    expect(`${refused.message} ${refused.hint ?? ""}`).toContain("not a staging app");
    const at = h.clock.now - 60_000;
    expect(await db(["restore", "--at", String(at), "--as", "shop-old", "--app", "shop"], io, dir)).toBe(EXIT.OK);
    expect(lines.at(-1)).toContain("into the new app shop-old");
    expect((await h.request("GET", "/v1/apps/shop-old", { token })).status).toBe(200);
  });
});
