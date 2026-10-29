// Server stacks with original positions (#261): a `RENOX_INTERNAL` line of a
// handler that threw is read through streamLogs with `fields.frames`, each
// frame's `original` looked up in the deployment's private sourcemaps.
// Without a map, or for an unknown deployment, the frames stay raw; the
// stored line and `fields.stack` never change; the work per line is bounded.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash, writeTar } from "@renox/artifact-validate";
import { logIngest } from "../src/ingest/logs.ts";
import { BUDGET_MS, MAX_FRAMES, parseStack, withServerFrames } from "../src/logs/symbolicate-server.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, createApp_, type Harness, harness, nodeToken, sseReader, tenant } from "./helpers.ts";

afterEach(assertScoped);

/**
 * functions/api/hello.js line 3, column 11 (1-based) comes from
 * functions/api/hello.ts line 7, column 4: one segment [10, 0, 6, 3] on the
 * third generated line, base64 VLQ "UAMG".
 */
const MAP = JSON.stringify({ version: 3, sources: ["../../functions/api/hello.ts"], names: [], mappings: ";;UAMG" });
const STACK = [
  "Error: boom",
  "    at loadCart (file:///functions/api/hello.js:3:11)",
  "    at async GET (file:///functions/api/hello.js:9:2)",
  "    at ext:core/01_core.js:10:5",
].join("\n");

let seq = 0;
const thrown = (hash: string, stack = STACK) => {
  seq += 1;
  return {
    ts: 1_793_318_400_000 + seq,
    tenant_id: "t_hello",
    deployment_hash: hash,
    request_id: `01JBQ3Z7M8K5V6W9X2Y4A1B${String(seq).padStart(3, "0")}`,
    module: "functions/api/hello",
    level: "error",
    message: "handler threw",
    fields: { code: "RENOX_INTERNAL", route: "GET /api/hello", phase: "request", cause_name: "Error", cause_message: "boom", stack },
    source: "server",
  };
};

async function setup(withMap: boolean): Promise<{ h: Harness; token: string; node: string; hash: string }> {
  const h = await harness();
  const token = await tenant(h, "t_hello");
  await createApp_(h, token, "hello");
  const files = helloArtifact();
  expect((await upload(h, token, "hello", files)).status).toBe(201);
  const hash = contentHash(files);
  if (withMap) {
    const tar = writeTar(new Map([["functions/api/hello.js.map", new TextEncoder().encode(MAP)]]));
    const put = await h.request("PUT", `/v1/apps/hello/deployments/${hash}/sourcemaps`, { token, body: tar, headers: { "content-type": "application/x-tar" } });
    expect(put.status).toBeLessThan(300);
  }
  return { h, token, node: await nodeToken(h, "node-1"), hash };
}

const ingest = async (h: Harness, node: string, lines: unknown[]) =>
  expect((await h.request("POST", "/v1/ingest/logs", { token: node, json: { type: "log_batch", schema_version: 0, node_id: "node-1", lines } })).status).toBe(202);

type Frames = { file: string; line: number; column: number; function: string | null; original: { file: string; line: number; column: number } | null }[];

/** The `fields` of every `log` event of a stream that closes by itself. */
async function fieldsOf(res: Response): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    const data = /^data: (.*)$/mu.exec(block)?.[1];
    if (data !== undefined) out.push((JSON.parse(data) as { fields: Record<string, unknown> }).fields);
  }
  return out;
}

describe("server stacks through streamLogs", () => {
  test("a RENOX_INTERNAL line of a deployment with a map answers original frames; the raw stack and the stored line are unchanged", async () => {
    const { h, token, node, hash } = await setup(true);
    await ingest(h, node, [thrown(hash)]);
    const [fields] = await fieldsOf(await h.request("GET", "/v1/apps/hello/logs", { token }));
    expect(fields?.stack).toBe(STACK);
    expect(fields?.frames as Frames).toEqual([
      { file: "/functions/api/hello.js", line: 3, column: 11, function: "loadCart", original: { file: "functions/api/hello.ts", line: 7, column: 4 } },
      { file: "/functions/api/hello.js", line: 9, column: 2, function: "GET", original: null },
    ]);
    const stored = await logIngest(h.deps).store.read("t_hello", "hello", {});
    expect(stored[0]?.fields?.frames).toBeUndefined();
  });

  test("follow mode symbolicates live lines too, in order", async () => {
    const { h, token, node, hash } = await setup(true);
    const res = await h.request("GET", "/v1/apps/hello/logs?follow=true", { token });
    const sse = sseReader(res);
    await Bun.sleep(20);
    await ingest(h, node, [thrown(hash), { ...thrown(hash), fields: null, message: "plain" }]);
    const first = (await sse.next()).data as { fields: { frames: Frames } };
    expect(first.fields.frames[0]?.original).toEqual({ file: "functions/api/hello.ts", line: 7, column: 4 });
    const second = (await sse.next()).data as { message: string; fields: unknown };
    expect(second).toMatchObject({ message: "plain", fields: null });
    await sse.close();
  });

  test("without a map, or from an unknown deployment, the frames are raw", async () => {
    const { h, token, node, hash } = await setup(false);
    await ingest(h, node, [thrown(hash)]);
    const streamed = await fieldsOf(await h.request("GET", "/v1/apps/hello/logs", { token }));
    // An unknown deployment never passes ingestion; the symbolicator is asked directly.
    const unknown = await withServerFrames(h.deps, thrown("f".repeat(64)) as Parameters<typeof withServerFrames>[1]);
    const all = [...streamed, unknown.fields as Record<string, unknown>];
    expect(all).toHaveLength(2);
    for (const fields of all) {
      expect((fields.frames as Frames).map((f) => f.original)).toEqual([null, null]);
      expect(fields.stack).toBe(STACK);
    }
  });
});

describe("bounds", () => {
  test("at most 50 frames are read", () => {
    const long = Array.from({ length: 80 }, (_, i) => `    at f${i} (file:///functions/api/hello.js:${i + 1}:1)`).join("\n");
    expect(parseStack(long)).toHaveLength(MAX_FRAMES);
    expect(parseStack("Error\n    at native code\n    at ext:core/x.js:1:1")).toEqual([]);
  });

  test("after the 2 ms budget, the remaining frames stay raw", async () => {
    const { h, hash } = await setup(true);
    const line = thrown(hash, Array.from({ length: 5 }, () => "    at loadCart (file:///functions/api/hello.js:3:11)").join("\n")) as Parameters<typeof withServerFrames>[1];
    // A clock that advances 1 ms per reading: the budget is spent after two lookups.
    let t = 0;
    const out = await withServerFrames(h.deps, line, () => t++);
    const originals = (out.fields?.frames as Frames).map((f) => f.original !== null);
    expect(originals.filter(Boolean).length).toBeLessThanOrEqual(BUDGET_MS + 1);
    expect(originals.at(-1)).toBe(false);
    expect(originals[0]).toBe(true);
  });

  test("lines that are not server stacks are returned as they are", async () => {
    const { h, hash } = await setup(false);
    const client = { ...thrown(hash), source: "client" } as Parameters<typeof withServerFrames>[1];
    expect(await withServerFrames(h.deps, client)).toBe(client);
    const plain = { ...thrown(hash), fields: { code: "RENOX_INTERNAL" } } as Parameters<typeof withServerFrames>[1];
    expect(await withServerFrames(h.deps, plain)).toBe(plain);
  });
});

