// The unhandled-error log and upstream storage failures (#402):
// docs/23-failure-modes.md "Object storage unreachable" (the request answers
// 503 with Retry-After, which the CLI retries, instead of a bare 500), and
// docs/24-threat-model.md "Secrets in logs" (the cause chain is logged with
// tokens and credentials masked).

import { afterEach, describe, expect, test } from "bun:test";
import { named, upload } from "./artifacts.ts";
import { assertScoped, createApp_, harness, tenant } from "./helpers.ts";
import { UPSTREAM_RETRY_AFTER_S } from "../src/app.ts";
import { describeError, maskSecrets, stageOf, tagStage } from "../src/log.ts";
import { S3ObjectStore, storeCall } from "../src/storage/object-store.ts";
import { newTokenValue } from "../src/auth/tokens.ts";

afterEach(assertScoped);

type Line = { level: string; msg: string; stage?: string; error_name?: string; error_code?: string; error?: string; detail?: Record<string, unknown> };
const lines = (log: { lines: string[] }): Line[] => log.lines.map((l) => JSON.parse(l) as Line);

/** An error shaped like Bun's S3 client failure: a generic message, the useful parts in name, code and cause. */
function s3Failure(token: string): Error {
  const reset = Object.assign(new Error(`socket reset by peer, auth ${token}`), { name: "ECONNRESET", code: "ECONNRESET" });
  return Object.assign(new Error("an unexpected error has occurred", { cause: reset }), { name: "S3Error", code: "UnknownError" });
}

describe("upstream object-store failure", () => {
  test("an artifact PUT that fails answers 503 RENOX_UNAVAILABLE with Retry-After, and the log has name, code, cause and stage", async () => {
    const h = await harness();
    const token = await tenant(h, "t_s3", "free");
    await createApp_(h, token, "hello");
    const leaked = newTokenValue("pat");
    h.store.putIfAbsent = () => storeCall("put", () => Promise.reject(s3Failure(leaked)));

    const res = await upload(h, token, "hello", named("hello"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(UPSTREAM_RETRY_AFTER_S));
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("RENOX_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("ECONNRESET");

    const line = lines(h.log).find((l) => l.level === "error");
    expect(line).toBeDefined();
    expect(line?.stage).toBe("object_store.put");
    expect(line?.error_name).toBe("S3Error");
    expect(line?.error_code).toBe("UnknownError");
    const cause = line?.detail?.cause as { name: string; code: string; message: string };
    expect(cause.name).toBe("ECONNRESET");
    expect(cause.code).toBe("ECONNRESET");
    // The token in the cause is masked; the line holds no raw token at all.
    expect(cause.message).toContain("renox_pat_[redacted]");
    expect(h.log.lines.join("\n")).not.toContain(leaked);
    // No deployment row was recorded without its object.
    expect(await h.db.query("select 1 from deployments where tenant_id = 't_s3'")).toEqual([]);
  });

  test("the S3 store marks a connection failure with its stage (nothing listens on the endpoint)", async () => {
    const store = new S3ObjectStore({ endpoint: "http://127.0.0.1:1", bucket: "b", region: "auto", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI" });
    const err = await store.putIfAbsent("artifacts/x.tar", new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(stageOf(err)).toBe("object_store.put");
    const got = await store.get("artifacts/x.tar").catch((e: unknown) => e);
    expect(stageOf(got)).toBe("object_store.get");
  });
});

describe("unhandled error log", () => {
  test("a database failure stays 500 and is logged with stage db, name and code", async () => {
    const h = await harness([
      (app, deps) => {
        app.get("/v1/boom-db", async () => {
          await deps.db.query("select * from no_such_table_402");
          return new Response("unreachable");
        });
      },
    ]);
    const res = await h.request("GET", "/v1/boom-db");
    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RENOX_INTERNAL");
    const line = lines(h.log).find((l) => l.msg === "unhandled error");
    expect(line?.stage).toBe("db");
    expect(line?.error_code).toBe("42P01"); // undefined_table
    expect(line?.error).toContain("no_such_table_402");
  });

  test("a handler bug is logged with stage handler, its stack and a recursive cause chain", async () => {
    const h = await harness([
      (app) => {
        app.get("/v1/boom-chain", () => {
          const root = Object.assign(new Error("root cause"), { code: "EROOT" });
          const mid = new TypeError("middle", { cause: root });
          throw new Error("top", { cause: mid });
        });
      },
    ]);
    const res = await h.request("GET", "/v1/boom-chain");
    expect(res.status).toBe(500);
    const line = lines(h.log).find((l) => l.msg === "unhandled error") as Line;
    expect(line.stage).toBe("handler");
    expect(line.error).toBe("top");
    const detail = line.detail as { stack: string; cause: { name: string; cause: { message: string; code: string } } };
    expect(detail.stack).toContain("top");
    expect(detail.cause.name).toBe("TypeError");
    expect(detail.cause.cause).toMatchObject({ message: "root cause", code: "EROOT" });
  });
});

describe("describeError", () => {
  test("stops at a cyclic or very deep chain, and handles non-errors", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    let depth = 0;
    for (let d: Record<string, unknown> | undefined = describeError(a) as unknown as Record<string, unknown>; d !== undefined; d = d.cause as Record<string, unknown> | undefined) depth++;
    expect(depth).toBe(6);
    expect(describeError("plain")).toEqual({ name: "string", message: "plain" });
    expect(describeError({ x: 1 })).toEqual({ name: "NonError", message: '{"x":1}' });
  });

  test("masks credentials that are not renox tokens", () => {
    const text = maskSecrets("GET https://user:pw@r2.example/b/k?X-Amz-Credential=AKID%2F1&X-Amz-Signature=abc123 Authorization: Bearer eyJabc.def Credential=AKID/2026");
    expect(text).not.toContain("pw@");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("eyJabc");
    expect(text).not.toContain("AKID");
  });

  test("the first stage mark wins and the error keeps its identity", () => {
    const e = new Error("x");
    expect(tagStage(tagStage(e, "db"), "object_store.put")).toBe(e);
    expect(stageOf(e)).toBe("db");
    expect(stageOf(new Error("outer", { cause: e }))).toBe("db");
    expect(Object.keys(e)).toEqual([]);
  });
});
