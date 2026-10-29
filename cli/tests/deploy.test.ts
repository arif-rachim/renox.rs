// renox deploy, renox logs, renox secrets (#58) against a fake control plane:
// the requests each command sends, its output, and the exit code contract
// (cli/README.md, "Exit codes"). The end to end run against the real API and
// a worker is tests/deploy.e2e.test.ts.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { extractTar } from "@renox/artifact-validate";

import { run as deploy } from "../src/commands/deploy.ts";
import type { Io } from "../src/commands/login.ts";
import { formatLine, parseSince, run as logs, sseEvents } from "../src/commands/logs.ts";
import { run as secrets, type SecretsIo, trimValue, valueProblem } from "../src/commands/secrets.ts";
import { CliError, EXIT } from "../src/errors.ts";

const repo = join(import.meta.dir, "../..");
const TOKEN = `renox_pat_${"a".repeat(32)}`;
const API = "https://api.test";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: Uint8Array | null;
}

type Answer = (c: Call) => Response | undefined | Promise<Response | undefined>;

interface FakeIo extends SecretsIo {
  lines: string[];
  calls: Call[];
  slept: number[];
}

function fake(answers: Answer[], value = ""): FakeIo {
  const lines: string[] = [];
  const calls: Call[] = [];
  const slept: number[] = [];
  return {
    lines,
    calls,
    slept,
    env: { RENOX_TOKEN: TOKEN, RENOX_API_URL: API, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")) },
    out: (l) => lines.push(l),
    sleep: async (ms) => {
      slept.push(ms);
    },
    readStdin: async () => "",
    readValue: async () => value,
    fetch: async (url, init) => {
      const raw = init?.body;
      const body = raw === undefined || raw === null ? null : typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw as Uint8Array);
      const call = { method: init?.method ?? "GET", path: url.slice(API.length), headers: new Headers(init?.headers), body };
      calls.push(call);
      for (const a of answers) {
        const r = await a(call);
        if (r !== undefined) return r;
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    },
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(status, { error: { code, message, request_id: "01JBQ3Z7MA0000000000000014", ...extra } });
const text = (c: Call) => (c.body === null ? null : JSON.parse(new TextDecoder().decode(c.body)));
const app = (active: string | null) => ({ name: "hello", tenant_id: "t-1", created_at: 0, active_deployment: active, hostnames: ["hello.renox.app"] });
const deployment = (hash: string, state: string) => ({ app: "hello", hash, state, created_at: 0, updated_at: 0, size_bytes: 10, permissions: { network: [], secrets: [] }, secrets_version: null, activated_at: null, last_error: null, violations: null });

/** examples/hello copied to a temp folder (no templates: no worker needed). */
function hello(): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-deploy-"));
  cpSync(join(repo, "examples/hello"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("_spike") && !src.includes(".renox") });
  return dir;
}

async function failure(p: Promise<unknown>): Promise<CliError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CliError);
  return e as CliError;
}

/** The happy path of the API for one deploy; `active` is the app's active hash before it. */
function controlPlane(active: string | null, overrides: Answer[] = []): Answer[] {
  let current = active;
  let uploaded = "";
  return [
    ...overrides,
    (c) => (c.method === "GET" && c.path === "/v1/apps/hello" ? json(200, app(current)) : undefined),
    (c) => {
      if (c.method !== "POST" || c.path !== "/v1/apps/hello/deployments") return undefined;
      uploaded = c.headers.get("x-renox-artifact-hash") ?? "";
      return json(201, deployment(uploaded, "validated"));
    },
    (c) => (c.method === "PUT" && c.path.endsWith("/sourcemaps") ? new Response(null, { status: 204 }) : undefined),
    (c) => {
      if (c.method !== "POST" || c.path !== "/v1/apps/hello/activate") return undefined;
      current = text(c).hash;
      return json(200, deployment(current as string, "active"));
    },
  ];
}

describe("renox deploy", () => {
  test("builds, uploads the artifact as a gzip tar named by its hash, uploads source maps, activates, prints the live URL and the rollback command", async () => {
    const t = fake(controlPlane(HASH_A));
    expect(await deploy([], t, hello())).toBe(EXIT.OK);
    const [getApp, upload, maps, activate, after] = t.calls;
    expect(getApp?.path).toBe("/v1/apps/hello");
    expect(upload?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(upload?.headers.get("content-type")).toBe("application/gzip");
    const hash = upload?.headers.get("x-renox-artifact-hash") as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    // The body is the artifact tree: manifest.json at the root, no leading directory.
    const files = await extractTar(gunzipSync(upload?.body as Uint8Array), { gzip: false });
    expect([...files.keys()]).toContain("manifest.json");
    expect([...files.keys()].every((p) => !p.startsWith(hash) && !p.endsWith(".map"))).toBe(true);
    expect(maps?.path).toBe(`/v1/apps/hello/deployments/${hash}/sourcemaps`);
    const mapFiles = await extractTar(gunzipSync(maps?.body as Uint8Array), { gzip: false });
    expect([...mapFiles.keys()].every((p) => p.endsWith(".map"))).toBe(true);
    expect(text(activate as Call)).toEqual({ hash });
    expect(after?.path).toBe("/v1/apps/hello");
    const out = t.lines.join("\n");
    expect(out).toMatch(/Bundling… \d+ routes, \d+ modules, 0 templates/u);
    expect(out).toContain("Uploading");
    expect(out).toContain(`Live: https://hello.renox.app  (${hash.slice(0, 12)})`);
    expect(out).toContain(`Rollback: renox deploy --rollback ${HASH_A.slice(0, 12)}`);
  });

  test("--json prints one summary with the stage times (B15)", async () => {
    const t = fake(controlPlane(null));
    expect(await deploy(["--json"], t, hello())).toBe(EXIT.OK);
    expect(t.lines).toHaveLength(1);
    const s = JSON.parse(t.lines[0] as string);
    expect(s).toMatchObject({ app: "hello", previous: null, url: "https://hello.renox.app", sourcemaps: "uploaded" });
    expect(Object.keys(s.stages)).toEqual(["build_ms", "upload_ms", "sourcemaps_ms", "activate_ms"]);
  });

  test("an app that does not exist yet is created first", async () => {
    let created = false;
    const t = fake(
      controlPlane(null, [
        (c) => (c.method === "GET" && c.path === "/v1/apps/hello" && !created ? err(404, "RENOX_NOT_FOUND", "Not found.") : undefined),
        (c) => {
          if (c.method !== "POST" || c.path !== "/v1/apps") return undefined;
          created = true;
          expect(text(c)).toEqual({ name: "hello" });
          return json(201, app(null));
        },
      ]),
    );
    expect(await deploy([], t, hello())).toBe(EXIT.OK);
    expect(t.lines).toContain("  Created app hello");
  });

  test("the upload is retried on a network failure and a 5xx, then succeeds; activation waits Retry-After on 503", async () => {
    let uploads = 0;
    let activations = 0;
    const t = fake(
      controlPlane(null, [
        (c) => {
          if (c.path !== "/v1/apps/hello/deployments") return undefined;
          uploads++;
          if (uploads === 1) throw new Error("connection reset");
          if (uploads === 2) return err(500, "RENOX_INTERNAL", "Internal error.");
          return undefined;
        },
        (c) => (c.path === "/v1/apps/hello/activate" && ++activations === 1 ? err(503, "RENOX_UNAVAILABLE", "Unavailable.", {}) : undefined),
      ]),
    );
    // A 503 with Retry-After: 5.
    const fetch = t.fetch;
    t.fetch = async (url, init) => {
      const r = await fetch(url, init);
      return r.status === 503 ? new Response(r.body, { status: 503, headers: { "retry-after": "5" } }) : r;
    };
    expect(await deploy([], t, hello())).toBe(EXIT.OK);
    expect(uploads).toBe(3);
    expect(activations).toBe(2);
    expect(t.slept).toEqual([1000, 2000, 5000]);
  });

  test("exit codes: not signed in 1; unreachable API 3; rejected artifact 2; failed activation 2; 403 1; conflict 1; build error 2", async () => {
    const project = hello();
    const signedOut = fake([]);
    signedOut.env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")) };
    const e1 = await failure(deploy([], signedOut, project));
    expect(e1.exitCode).toBe(EXIT.USER);
    expect(e1.hint).toContain("renox login");
    expect(signedOut.calls).toEqual([]);

    const down = fake([
      () => {
        throw new Error("connection refused");
      },
    ]);
    expect((await failure(deploy([], down, project))).exitCode).toBe(EXIT.ENVIRONMENT);

    const rejected = fake(
      controlPlane(null, [
        (c) =>
          c.path === "/v1/apps/hello/deployments"
            ? err(422, "RENOX_DEPLOY_REJECTED", "The artifact was rejected.", { deployment: HASH_A, details: [{ rule: "H1", path: "public/.env", reason: "environment file" }] })
            : undefined,
      ]),
    );
    const e3 = await failure(deploy([], rejected, project));
    expect(e3.exitCode).toBe(EXIT.VALIDATION);
    expect(e3.message).toContain("RENOX_DEPLOY_REJECTED");
    expect(e3.message).toContain("rule=H1 path=public/.env reason=environment file");
    expect(rejected.slept).toEqual([]); // a 422 is never retried

    const failed = fake(
      controlPlane(HASH_A, [
        (c) =>
          c.path === "/v1/apps/hello/activate"
            ? err(422, "RENOX_ACTIVATION_FAILED", "The new deployment could not be activated.", { details: [{ stage: "migrate", module: "app", file: "002_x.sql", reason: "no such table: x" }] })
            : undefined,
      ]),
    );
    const e4 = await failure(deploy([], failed, project));
    expect(e4.exitCode).toBe(EXIT.VALIDATION);
    expect(e4.message).toContain("stage=migrate");

    const scope = fake(controlPlane(null, [(c) => (c.path === "/v1/apps/hello/deployments" ? err(403, "RENOX_TOKEN_SCOPE", "The token does not allow this.") : undefined)]));
    expect((await failure(deploy([], scope, project))).exitCode).toBe(EXIT.USER);

    const busy = fake(controlPlane(null, [(c) => (c.path === "/v1/apps/hello/activate" ? err(409, "RENOX_CONFLICT", "Conflict.", { details: [{ field: "state", reason: "another activation is in progress" }] }) : undefined)]));
    expect((await failure(deploy([], busy, project))).exitCode).toBe(EXIT.USER);

    const broken = hello();
    await Bun.write(join(broken, "functions/api/hello.ts"), "export const GET = ( => 1;\n");
    const e7 = await failure(deploy([], fake(controlPlane(null)), broken));
    expect(e7.exitCode).toBe(EXIT.VALIDATION);

    for (const bad of [["--frobnicate"], ["--app", "x"], ["--rollback", "--app", "Bad"]]) expect((await failure(deploy(bad, fake([]), project))).exitCode).toBe(EXIT.USER);
  });
});

describe("renox deploy --rollback", () => {
  test("without a hash: POST rollback {}; prints the live hash and the undo command", async () => {
    let active = HASH_B;
    const t = fake([
      (c) => (c.method === "GET" && c.path === "/v1/apps/hello" ? json(200, app(active)) : undefined),
      (c) => {
        if (c.path !== "/v1/apps/hello/rollback") return undefined;
        expect(text(c)).toEqual({});
        active = HASH_A;
        return json(200, deployment(HASH_A, "active"));
      },
    ]);
    expect(await deploy(["--rollback", "--app", "hello"], t, "/nonexistent")).toBe(EXIT.OK);
    expect(t.lines[0]).toContain(`Rolled back: https://hello.renox.app  (${HASH_A.slice(0, 12)})`);
    expect(t.lines[1]).toBe(`  Undo: renox deploy --rollback ${HASH_B.slice(0, 12)}`);
  });

  test("a hash prefix is resolved among the superseded deployments; an unknown or ambiguous one is a user error", async () => {
    const answers: Answer[] = [
      (c) => (c.path === "/v1/apps/hello/deployments?state=superseded&limit=100" ? json(200, { deployments: [deployment(HASH_A, "superseded"), deployment(`aaaaaab${"0".repeat(57)}`, "superseded")] }) : undefined),
      (c) => (c.method === "GET" && c.path === "/v1/apps/hello" ? json(200, app(HASH_B)) : undefined),
      (c) => (c.path === "/v1/apps/hello/rollback" ? json(200, deployment(text(c).hash, "active")) : undefined),
    ];
    const t = fake(answers);
    expect(await deploy(["--rollback", "aaaaaaa", "--app", "hello", "--json"], t, "/nonexistent")).toBe(EXIT.OK);
    expect(text(t.calls.find((c) => c.path.endsWith("/rollback")) as Call)).toEqual({ hash: HASH_A });
    expect(JSON.parse(t.lines[0] as string)).toMatchObject({ hash: HASH_A, previous: HASH_B });
    expect((await failure(deploy(["--rollback", "aaa0aa", "--app", "hello"], fake(answers), "/x"))).message).toContain("no superseded deployment");
    expect((await failure(deploy(["--rollback", "aaa", "--app", "hello"], fake(answers), "/x"))).exitCode).toBe(EXIT.USER);
    expect((await failure(deploy(["--rollback", "aaaaaa", "--app", "hello"], fake(answers), "/x"))).message).toContain("matches 2 deployments");
  });

  test("nothing to roll back to (409) is a user error with the API's reason", async () => {
    const t = fake([
      (c) => (c.method === "GET" ? json(200, app(HASH_A)) : undefined),
      () => err(409, "RENOX_CONFLICT", "The request conflicts with the current state.", { details: [{ field: "state", reason: "there is no superseded deployment" }] }),
    ]);
    const e = await failure(deploy(["--rollback", "--app", "hello"], t, "/x"));
    expect(e.exitCode).toBe(EXIT.USER);
    expect(e.message).toContain("there is no superseded deployment");
  });
});

const LINE = { ts: 1793318400200, tenant_id: "t_hello", deployment_hash: HASH_A, request_id: "01JBQ3Z7M8K5V6W9X2Y4A1B3C5", module: "functions/api/hello", level: "info", message: "hello key=[redacted]", fields: null, source: "server" };
const sse = (chunks: string[], hold = false): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(ctl) {
        for (const c of chunks) ctl.enqueue(new TextEncoder().encode(c));
        if (!hold) ctl.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const event = (id: string, line: object) => `event: log\nid: ${id}\ndata: ${JSON.stringify(line)}\n\n`;

describe("renox logs", () => {
  test("SSE parsing: events split across chunks, comments ignored, multi-line data, CRLF", async () => {
    const body = sse(["event: log\nid: 1-0\nda", "ta: {\"a\":1}\n\n: keep-alive\n\n", "event: log\r\ndata: x\r\ndata: y\r\n\r\n"]).body as ReadableStream<Uint8Array>;
    const got = [];
    for await (const e of sseEvents(body)) got.push(e);
    expect(got).toEqual([
      { event: "log", id: "1-0", data: '{"a":1}' },
      { event: "log", id: undefined, data: "x\ny" },
    ]);
  });

  test("without --follow: the last lines, formatted, then exit 0; filters become query parameters", async () => {
    const t = fake([(c) => (c.path.startsWith("/v1/apps/hello/logs") ? sse([event("1-0", LINE), ": keep-alive\n\n", event("2-0", { ...LINE, source: "client", level: "error", message: "boom" })]) : undefined)]);
    expect(await logs(["--app", "hello", "--source", "client", "--since", "1793318400000"], t)).toBe(EXIT.OK);
    expect(t.calls[0]?.path).toBe("/v1/apps/hello/logs?since=1793318400000&source=client");
    expect(t.calls[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(t.lines).toEqual([formatLine(LINE as never), formatLine({ ...LINE, source: "client", level: "error", message: "boom" } as never)]);
    expect(t.lines[1]).toContain("[browser] functions/api/hello  boom  (01JBQ3Z7M8K5V6W9X2Y4A1B3C5)");
  });

  test("--follow streams the SSE endpoint and resumes with Last-Event-ID after the stream drops", async () => {
    let connects = 0;
    const t = fake([
      (c) => {
        if (!c.path.startsWith("/v1/apps/hello/logs")) return undefined;
        connects++;
        expect(c.path).toBe("/v1/apps/hello/logs?follow=true");
        if (connects === 1) {
          expect(c.headers.get("last-event-id")).toBeNull();
          return sse([event("1-0", LINE), event("1-1", { ...LINE, message: "second" })]);
        }
        if (connects === 2) {
          expect(c.headers.get("last-event-id")).toBe("1-1");
          throw new Error("connection reset");
        }
        if (connects === 3) {
          expect(c.headers.get("last-event-id")).toBe("1-1");
          return sse([event("2-0", { ...LINE, message: "third" })]);
        }
        if (c.headers.get("last-event-id") !== "2-0") return json(500, { unexpected: c.headers.get("last-event-id") });
        // Then the stream's API is gone for good: 10 failures end it with exit 3.
        throw new Error("connection refused");
      },
    ]);
    const e = await failure(logs(["--app", "hello", "--follow", "--json"], t));
    expect(e.exitCode).toBe(EXIT.ENVIRONMENT);
    expect(e.message).toContain("gave up after 10 reconnects");
    expect(t.lines.map((l) => JSON.parse(l).message)).toEqual(["hello key=[redacted]", "second", "third"]);
    expect(t.slept.slice(0, 4)).toEqual([1000, 2000, 1000, 2000]);
    expect(Math.max(...t.slept)).toBe(30_000);
  });

  test("401, 403 and 404 end --follow at once with exit 1; bad flags are exit 1", async () => {
    for (const [status, code] of [
      [401, "RENOX_UNAUTHENTICATED"],
      [403, "RENOX_TOKEN_SCOPE"],
      [404, "RENOX_NOT_FOUND"],
    ] as const) {
      const t = fake([() => err(status, code, "x")]);
      expect((await failure(logs(["--app", "hello", "--follow"], t))).exitCode).toBe(EXIT.USER);
      expect(t.calls).toHaveLength(1);
    }
    for (const bad of [["--source", "kernel"], ["--deployment", "abc"], ["--since", "yesterday"], ["--tail"]]) expect((await failure(logs(["--app", "hello", ...bad], fake([])))).exitCode).toBe(EXIT.USER);
    expect(parseSince("10m", 1_000_000)).toBe(400_000);
  });
});

describe("renox secrets", () => {
  const VALUE = "s3cr3t-value-never-printed";

  test("set reads the value from stdin, sends it once, and never prints it", async () => {
    const t = fake([(c) => (c.method === "PUT" && c.path === "/v1/apps/hello/secrets/STRIPE_KEY" ? json(200, { name: "STRIPE_KEY", version: 3 }) : undefined)], `${VALUE}\n`);
    expect(await secrets(["set", "STRIPE_KEY", "--app", "hello"], t)).toBe(EXIT.OK);
    expect(text(t.calls[0] as Call)).toEqual({ value: VALUE });
    expect(t.lines).toEqual(["Set STRIPE_KEY (secret version 3). The next `renox deploy` or rollback uses it; the active deployment keeps its pinned version."]);
    expect(t.lines.join("\n")).not.toContain(VALUE);
  });

  test("list shows names and the version; rm removes; no value appears", async () => {
    const t = fake([
      (c) => (c.method === "GET" ? json(200, { version: 4, secrets: [{ name: "STRIPE_KEY", updated_at: 1793318400000 }] }) : undefined),
      (c) => (c.method === "DELETE" && c.path.endsWith("/STRIPE_KEY") ? json(200, { name: "STRIPE_KEY", version: 5 }) : undefined),
    ]);
    expect(await secrets(["list", "--app", "hello"], t)).toBe(EXIT.OK);
    expect(t.lines).toEqual([`${"STRIPE_KEY".padEnd(32)}  updated 2026-10-30 00:00`, "secret version 4"]);
    expect(await secrets(["rm", "STRIPE_KEY", "--app", "hello"], t)).toBe(EXIT.OK);
    expect(t.lines[2]).toContain("Removed STRIPE_KEY (secret version 5)");
  });

  test("exit codes: a value on the command line, a short or empty value, a bad name are exit 1 and nothing is sent; 403 exit 1; 5xx exit 3", async () => {
    const short = "abc12";
    for (const [args, value] of [
      [["set", "KEY", VALUE], VALUE],
      [["set", "KEY"], short],
      [["set", "KEY"], ""],
      [["set", "lower"], VALUE],
      [["set"], VALUE],
      [["frobnicate"], VALUE],
      [["list", "EXTRA"], VALUE],
    ] as const) {
      const t = fake([], value);
      const e = await failure(secrets([...args, "--app", "hello"], t));
      expect(e.exitCode).toBe(EXIT.USER);
      expect(t.calls).toEqual([]);
      expect(`${e.message} ${e.hint ?? ""}`).not.toContain(VALUE);
      if (value === short) expect(e.message).not.toContain(short);
    }
    const scope = fake([() => err(403, "RENOX_TOKEN_SCOPE", "The token does not allow this.")], VALUE);
    expect((await failure(secrets(["set", "KEY", "--app", "hello"], scope))).exitCode).toBe(EXIT.USER);
    const down = fake([() => err(503, "RENOX_UNAVAILABLE", "Unavailable.")], VALUE);
    const e = await failure(secrets(["set", "KEY", "--app", "hello"], down));
    expect(e.exitCode).toBe(EXIT.ENVIRONMENT);
    expect(e.message).not.toContain(VALUE);
  });

  test("value rules match deploy-api.md section 9", () => {
    expect(trimValue("abc\r\n")).toBe("abc");
    expect(trimValue("abc\n\n")).toBe("abc\n");
    expect(valueProblem("12345678")).toBeNull();
    expect(valueProblem("1234567")).toContain("too short");
    expect(valueProblem("ééééééé")).toContain("too short"); // 14 bytes, 7 characters
    expect(valueProblem("x".repeat(64 * 1024 + 1))).toContain("at most");
  });
});

// Unused, but keeps the fake's type honest against Io.
export const _io: (f: FakeIo) => Io = (f) => f;
