import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MESSAGES } from "../src/errors.ts";
import { check } from "../src/contract.ts";
import { auditRows, createApp_, harness, tenant } from "./helpers.ts";

describe("audit", () => {
  test("every mutating call writes one row, whatever its outcome; reads write none", async () => {
    const h = await harness();
    const token = await tenant(h, "t_a");
    await createApp_(h, token, "alpha");
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "alpha" } })).status).toBe(409);
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "Bad" } })).status).toBe(400);
    expect((await h.request("POST", "/v1/apps", { json: { name: "x" } })).status).toBe(401);
    await h.request("GET", "/v1/apps", { token });
    await h.request("GET", "/v1/apps/alpha", { token });
    const rows = await auditRows(h);
    expect(rows.map((r) => [r.action, r.status, r.tenant_id])).toEqual([
      ["createApp", 201, "t_a"],
      ["createApp", 409, "t_a"],
      ["createApp", 400, "t_a"],
      ["createApp", 401, null],
    ]);
    expect(rows[0]?.actor).toMatch(/^token:tok_/u);
    expect(rows[3]?.actor).toBe("anonymous");
  });

  test("audit rows and logs never contain a token value", async () => {
    const h = await harness();
    const token = await tenant(h, "t_a");
    await h.request("POST", "/v1/tokens", { token, json: { name: "ci", scopes: ["deploy"], expires_in_days: 7 } });
    const created = (await (await h.request("POST", "/v1/tokens", { token, json: { name: "ci2", scopes: ["deploy"], expires_in_days: 7 } })).json()) as {
      token: string;
    };
    const audit = JSON.stringify(await auditRows(h));
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(created.token);
    const logs = h.log.lines.join("\n");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(created.token);
    h.log.info("leak test", { value: created.token });
    expect(h.log.lines.at(-1)).toContain("renox_pat_[redacted]");
  });
});

describe("apps", () => {
  test("create, list, get; names are global and validated", async () => {
    const h = await harness();
    const a = await tenant(h, "t_a");
    const b = await tenant(h, "t_b");
    const res = await h.request("POST", "/v1/apps", { token: a, json: { name: "hello" } });
    expect(res.status).toBe(201);
    const app = check<Record<string, unknown>>("App", await res.json());
    expect(app).toEqual({ name: "hello", tenant_id: "t_a", created_at: h.clock.now, active_deployment: null, hostnames: ["hello.renox.app"] });
    const taken = await h.request("POST", "/v1/apps", { token: b, json: { name: "hello" } });
    expect(taken.status).toBe(409);
    expect(await taken.text()).not.toContain("t_a");
    const extra = await h.request("POST", "/v1/apps", { token: a, json: { name: "x", owner: "t_b" } });
    expect(extra.status).toBe(400);
    expect(((await extra.json()) as { error: { details: { field: string }[] } }).error.details[0]?.field).toBe("owner");
    const list = (await (await h.request("GET", "/v1/apps", { token: a })).json()) as { apps: { name: string }[] };
    expect(list.apps.map((x) => x.name)).toEqual(["hello"]);
    const secretSet = await h.db.query<{ version: number }>("select version from secret_sets where app = 'hello'");
    expect(secretSet[0]?.version).toBe(0);
  });

  test("JSON bodies: content type, UTF-8, and the 1 MiB cap", async () => {
    const h = await harness();
    const token = await tenant(h, "t_a");
    const wrongType = await h.request("POST", "/v1/apps", { token, body: '{"name":"a"}', headers: { "content-type": "text/plain" } });
    expect(wrongType.status).toBe(400);
    const notJson = await h.request("POST", "/v1/apps", { token, body: "{", headers: { "content-type": "application/json" } });
    expect(notJson.status).toBe(400);
    const big = await h.request("POST", "/v1/apps", {
      token,
      body: JSON.stringify({ name: "a".repeat(2 * 1024 * 1024) }),
      headers: { "content-type": "application/json" },
    });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("RENOX_BODY_TOO_LARGE");
  });

  test("unknown paths answer the JSON 404 with a request id", async () => {
    const h = await harness();
    const res = await h.request("GET", "/v1/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-renox-request-id")).toMatch(/^[0-9A-Z]{26}$/u);
  });
});

describe("health", () => {
  test("ok when Postgres and storage answer; 503 when storage fails", async () => {
    const h = await harness();
    const ok = await h.request("GET", "/v1/healthz");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "ok", postgres: "ok", object_storage: "ok" });
    h.store.ping = () => Promise.reject(new Error("down"));
    const down = await h.request("GET", "/v1/healthz");
    expect(down.status).toBe(503);
    expect(((await down.json()) as { object_storage: string }).object_storage).toBe("unreachable");
  });
});

describe("contract", () => {
  test("error messages equal the fixed messages of docs/contracts/errors.md", () => {
    const errors = readFileSync(new URL("../../../docs/contracts/errors.md", import.meta.url), "utf8");
    for (const [code, message] of Object.entries(MESSAGES)) {
      const row = errors.split("\n").find((l) => l.startsWith(`| \`${code}\` |`));
      expect(row, code).toBeDefined();
      expect(row?.split(" | ")[4], code).toBe(message);
    }
  });

  test("an unhandled error answers RENOX_INTERNAL without its message", async () => {
    const h = await harness([
      (app) => {
        app.get("/v1/boom", () => {
          throw new Error("secret detail /var/lib/x");
        });
      },
    ]);
    const res = await h.request("GET", "/v1/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("RENOX_INTERNAL");
    expect(text).not.toContain("secret detail");
    expect(h.log.lines.some((l) => l.includes("secret detail"))).toBe(true);
  });
});
