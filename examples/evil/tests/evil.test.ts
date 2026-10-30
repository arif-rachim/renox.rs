// Unit checks of the evil functions that are safe to run outside the worker.
// loop, alloc and hang are never called here: they only end when a platform
// limit stops them (crates/renox-runtime limits tests, B12).

import { expect, test } from "bun:test";
import { type Ctx, FetchBlockedError } from "renox";
import { GET as leak } from "../functions/api/leak.ts";
import { GET as redirect } from "../functions/api/redirect.ts";
import { GET as slow } from "../functions/api/slow.ts";
import { GET as ssrf } from "../functions/api/ssrf.ts";

const SECRET = "fake-secret-value-0123456789";

function ctx(path: string, over: Partial<Ctx> = {}): Ctx {
  const req = new Request(`https://evil.renox.test${path}`);
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);
  return {
    req,
    url: new URL(req.url),
    params: {},
    headers: req.headers,
    db: {} as Ctx["db"],
    fetch: () => Promise.reject(new Error("no network in unit tests")),
    secrets: Object.freeze({}),
    log: { debug: log, info: log, warn: log, error: log },
    deadline: { remainingMs: () => 30_000 },
    module: "app",
    config: Object.freeze({}),
    services: Object.freeze({}),
    events: { emit: () => Promise.reject(new Error("no events in unit tests")) },
    hooks: { run: () => Promise.resolve({ halt: false }) },
    password: { hash: () => Promise.reject(new Error("no password op in unit tests")), verify: () => Promise.resolve(false) },
    principal: null,
    authz: {
      require: () => Promise.reject(new Error("no authz in unit tests")),
      can: () => Promise.resolve(false),
      canBatch: (_a, rs) => Promise.resolve(rs.map(() => false)),
      explain: () => Promise.resolve({ decision: "deny", reasons: [], errors: [] }),
      roles: { assign: () => Promise.resolve(), revoke: () => Promise.resolve(false), list: () => Promise.resolve([]) },
    },
    realtime: {
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
      publish: () => Promise.resolve(0),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
    jobs: {
      enqueue: () => Promise.reject(new Error("no jobs in unit tests")),
      list: () => Promise.reject(new Error("no jobs in unit tests")),
      retry: () => Promise.reject(new Error("no jobs in unit tests")),
      cancel: () => Promise.reject(new Error("no jobs in unit tests")),
    },
    ...over,
  };
}

test("slow busy-waits about the requested CPU time and validates ms", async () => {
  const started = performance.now();
  const res = await slow(ctx("/api/slow?ms=20"));
  expect(res.status).toBe(200);
  expect(performance.now() - started).toBeGreaterThanOrEqual(19);
  expect((await res.json()).ms).toBe(20);
  for (const bad of ["-1", "1.5", "abc", "10001"]) {
    expect((await slow(ctx(`/api/slow?ms=${bad}`))).status).toBe(400);
  }
});

test("redirect answers 302 to loopback", async () => {
  const res = await redirect(ctx("/api/redirect"));
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("http://127.0.0.1/");
});

test("ssrf reports a blocked fetch, and rethrows it with uncaught=1", async () => {
  const seen: string[] = [];
  const blocking: Ctx["fetch"] = (input) => {
    seen.push(String(input));
    return Promise.reject(new FetchBlockedError("blocked", { host: "169.254.169.254", reason: "blocked_address" }));
  };
  const res = await ssrf(ctx("/api/ssrf?target=metadata", { fetch: blocking }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ target: "metadata", blocked: true, code: "RENOX_FETCH_BLOCKED", reason: "blocked_address" });
  expect(seen).toEqual(["http://169.254.169.254/latest/meta-data/"]);
  await expect(ssrf(ctx("/api/ssrf?target=metadata&uncaught=1", { fetch: blocking }))).rejects.toBeInstanceOf(FetchBlockedError);
});

test("ssrf turns a fetch that was not blocked into a 500", async () => {
  const open: Ctx["fetch"] = () => Promise.resolve(new Response("metadata!"));
  for (const target of ["metadata", "localhost", "private", "redirect", "notlisted"]) {
    const res = await ssrf(ctx(`/api/ssrf?target=${target}`, { fetch: open }));
    expect(res.status).toBe(500);
    expect((await res.json()).blocked).toBe(false);
  }
  expect((await ssrf(ctx("/api/ssrf?target=elsewhere"))).status).toBe(400);
});

test("leak tries to log the secret but never returns it", async () => {
  const logged: string[] = [];
  const res = await leak(
    ctx("/api/leak", {
      secrets: Object.freeze({ FAKE_SECRET: SECRET }),
      log: {
        debug: (m) => logged.push(m),
        info: (m, f) => logged.push(`${m} ${JSON.stringify(f)}`),
        warn: (m) => logged.push(m),
        error: (m) => logged.push(m),
      },
    }),
  );
  const body = await res.text();
  expect(body).not.toContain(SECRET);
  expect(JSON.parse(body)).toEqual({ present: true, attempts: 4 });
  expect(logged.join("\n")).toContain(SECRET); // unredacted here: redaction is the runtime's job
});
