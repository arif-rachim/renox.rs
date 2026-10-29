// GET /v1/apps/{app}/logs (streamLogs, deploy-api.md section 11, #223): the
// SSE stream over the store POST /v1/ingest/logs fills, and the rule that
// client lines stay outside the per-minute cap (client-events.md section 7).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@renox/artifact-validate";
import { run as renoxLogs } from "../../../cli/src/commands/logs.ts";
import type { Io } from "../../../cli/src/commands/login.ts";
import { logIngest, LOG_LINES_PER_MINUTE } from "../src/ingest/logs.ts";
import { helloArtifact, named, upload } from "./artifacts.ts";
import { assertScoped, createApp_, type Harness, harness, nodeToken, scopedToken, sseReader, tenant } from "./helpers.ts";

afterEach(assertScoped);

let seq = 0;
const line = (hash: string, over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    ts: 1_793_318_400_000 + seq,
    tenant_id: "t_hello",
    deployment_hash: hash,
    request_id: "01JBQ3Z7M8K5V6W9X2Y4A1B3C5",
    module: "functions/api/hello",
    level: "info",
    message: `line ${seq}`,
    fields: null,
    source: "server",
    ...over,
  };
};
const batch = (lines: unknown[]) => ({ type: "log_batch", schema_version: 0, node_id: "node-1", lines });

async function setup(): Promise<{ h: Harness; token: string; node: string; hash: string }> {
  const h = await harness();
  const token = await tenant(h, "t_hello");
  await createApp_(h, token, "hello");
  const files = helloArtifact();
  expect((await upload(h, token, "hello", files)).status).toBe(201);
  return { h, token, node: await nodeToken(h, "node-1"), hash: contentHash(files) };
}

const ingest = async (h: Harness, node: string, lines: unknown[]) => expect((await h.request("POST", "/v1/ingest/logs", { token: node, json: batch(lines) })).status).toBe(202);
const open = (h: Harness, token: string, qs = "", headers: Record<string, string> = {}) => h.request("GET", `/v1/apps/hello/logs${qs}`, { token, headers });

/** Every `log` event of a stream that closes by itself. */
async function drain(res: Response): Promise<{ id: string; message: string }[]> {
  const out: { id: string; message: string }[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    const id = /^id: (.*)$/mu.exec(block)?.[1];
    const data = /^data: (.*)$/mu.exec(block)?.[1];
    if (id !== undefined && data !== undefined) out.push({ id, message: (JSON.parse(data) as { message: string }).message });
  }
  return out;
}

describe("GET /v1/apps/{app}/logs", () => {
  test("without follow: the last 100 lines, oldest first, then the stream closes", async () => {
    const { h, token, node, hash } = await setup();
    await ingest(h, node, Array.from({ length: 120 }, () => line(hash)));
    const res = await open(h, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const lines = await drain(res);
    expect(lines).toHaveLength(100);
    expect(lines[0]?.message).toBe(`line ${seq - 99}`);
    expect(lines[99]?.message).toBe(`line ${seq}`);
    expect(lines[0]?.id).toMatch(/^[0-9]+-[0-9]+$/u);
  });

  test("an event's data is exactly the contract's log_line", async () => {
    const { h, token, node, hash } = await setup();
    const l = line(hash);
    await ingest(h, node, [l]);
    const block = (await (await open(h, token)).text()).split("\n\n")[0] as string;
    expect(block).toStartWith("event: log\n");
    expect(JSON.parse(/^data: (.*)$/mu.exec(block)?.[1] as string)).toEqual(l);
  });

  test("since keeps the lines at or after it", async () => {
    const { h, token, node, hash } = await setup();
    const lines = [line(hash), line(hash), line(hash)];
    await ingest(h, node, lines);
    expect((await drain(await open(h, token, `?since=${lines[1]?.ts}`))).map((l) => l.message)).toEqual([lines[1], lines[2]].map((l) => (l as { message: string }).message));
  });

  test("source and deployment filter the lines before the tail is taken", async () => {
    const { h, token, node, hash } = await setup();
    await ingest(h, node, [line(hash, { source: "client", message: "browser" }), ...Array.from({ length: 150 }, () => line(hash))]);
    expect((await drain(await open(h, token, "?source=client"))).map((l) => l.message)).toEqual(["browser"]);
    expect(await drain(await open(h, token, "?source=server"))).toHaveLength(100);
    expect(await drain(await open(h, token, `?deployment=${"0".repeat(64)}`))).toEqual([]);
    expect(await drain(await open(h, token, `?deployment=${hash}&source=client`))).toHaveLength(1);
  });

  test("bad query values and Last-Event-ID are 400", async () => {
    const { h, token } = await setup();
    for (const qs of ["?follow=yes", "?since=-1", "?source=other", "?deployment=abc"]) expect((await open(h, token, qs)).status).toBe(400);
    expect((await open(h, token, "", { "last-event-id": "x" })).status).toBe(400);
  });

  test("follow=true receives a line ingested after the stream opened, and keeps alive", async () => {
    const { h, token, node, hash } = await setup();
    await ingest(h, node, [line(hash, { message: "before" })]);
    logIngest(h.deps).stream.keepAliveMs = 20;
    const res = await open(h, token, "?follow=true");
    const reader = sseReader(res);
    expect((await reader.next()).data).toMatchObject({ message: "before" });
    await ingest(h, node, [line(hash, { message: "after" })]);
    expect((await reader.next()).data).toMatchObject({ message: "after" });
    await reader.close();
  });

  test("the stream writes a keep-alive comment while idle", async () => {
    const { h, token } = await setup();
    logIngest(h.deps).stream.keepAliveMs = 20;
    const res = await open(h, token, "?follow=true");
    const body = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes(": keep-alive") && Date.now() < deadline) text += new TextDecoder().decode((await body.read()).value);
    expect(text).toContain(": keep-alive");
    await body.cancel();
  });

  test("reconnecting with Last-Event-ID gets only newer lines", async () => {
    const { h, token, node, hash } = await setup();
    await ingest(h, node, [line(hash, { message: "one" }), line(hash, { message: "two" })]);
    const seen = await drain(await open(h, token));
    expect(seen.map((l) => l.message)).toEqual(["one", "two"]);
    await ingest(h, node, [line(hash, { message: "three" })]);
    expect((await drain(await open(h, token, "", { "last-event-id": (seen[0] as { id: string }).id }))).map((l) => l.message)).toEqual(["two", "three"]);
    expect((await drain(await open(h, token, "", { "last-event-id": (seen[1] as { id: string }).id }))).map((l) => l.message)).toEqual(["three"]);

    const reader = sseReader(await open(h, token, "?follow=true", { "last-event-id": (seen[1] as { id: string }).id }));
    expect((await reader.next()).data).toMatchObject({ message: "three" });
    await ingest(h, node, [line(hash, { message: "four" })]);
    expect((await reader.next()).data).toMatchObject({ message: "four" });
    await reader.close();
  });

  /** docs/24-threat-model.md E, IDOR row: another tenant's resources are 404. */
  test("another tenant's token gets 404, and sees none of the lines", async () => {
    const { h, node, hash } = await setup();
    await ingest(h, node, [line(hash)]);
    const other = await tenant(h, "t_other");
    await createApp_(h, other, "other");
    expect((await open(h, other)).status).toBe(404);
    const files = named("other");
    expect((await upload(h, other, "other", files)).status).toBe(201);
    const own = await h.request("GET", "/v1/apps/other/logs", { token: other });
    expect(await drain(own)).toEqual([]);
  });

  test("a token without logs:read gets 403; no token gets 401", async () => {
    const { h } = await setup();
    expect((await open(h, await scopedToken(h, "t_hello", ["apps:read"]))).status).toBe(403);
    expect((await h.request("GET", "/v1/apps/hello/logs")).status).toBe(401);
    expect((await open(h, await scopedToken(h, "t_hello", ["logs:read:hello"]))).status).toBe(200);
  });

  /** A tenant must not hold the process open with follow streams. */
  test("the N+1th follow stream gets 429 RENOX_RATE_LIMITED; closing one frees a slot", async () => {
    const { h, token } = await setup();
    const cap = logIngest(h.deps).stream.maxFollowPerTenant;
    const readers: ReturnType<typeof sseReader>[] = [];
    for (let i = 0; i < cap; i++) {
      const res = await open(h, token, "?follow=true");
      expect(res.status).toBe(200);
      readers.push(sseReader(res));
    }
    const refused = await open(h, token, "?follow=true");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("RENOX_RATE_LIMITED");
    // A stream that is not followed is not counted.
    expect((await open(h, token)).status).toBe(200);
    await readers[0]?.close();
    await Bun.sleep(20);
    const again = await open(h, token, "?follow=true");
    expect(again.status).toBe(200);
    await again.body?.cancel();
    for (const r of readers.slice(1)) await r.close();
  });

  test("a client disconnect ends the follow stream and unsubscribes", async () => {
    const { h, token } = await setup();
    const res = await open(h, token, "?follow=true");
    expect(logIngest(h.deps).stream.open.get("t_hello")).toBe(1);
    await res.body?.cancel();
    await Bun.sleep(20);
    expect(logIngest(h.deps).stream.open.get("t_hello")).toBe(0);
  });
});

describe("client lines and the caps", () => {
  /** client-events.md section 7: client events count toward the daily cap only, so a browser flood cannot push server lines out. */
  test("a client line does not consume the per-minute cap; the daily counter increments", async () => {
    const { h, node, hash } = await setup();
    const cap = LOG_LINES_PER_MINUTE.free;
    const client = Array.from({ length: 1000 }, () => line(hash, { source: "client" }));
    for (let i = 0; i < cap / 1000 + 1; i++) await ingest(h, node, client.map((l) => ({ ...l, ts: l.ts + i * 10_000, message: `${l.message}/${i}` })));
    const { cap: volume, clientToday } = logIngest(h.deps);
    expect(volume.dropped.get("t_hello")).toBeUndefined();
    expect(clientToday.usedToday("t_hello", h.deps.now())).toBe(cap + 1000);
    // Server lines still have their whole minute.
    const res = await h.request("POST", "/v1/ingest/logs", { token: node, json: batch(Array.from({ length: 1000 }, () => line(hash))) });
    expect(await res.json()).toEqual({ accepted: 1000, duplicates: 0 });
    expect(volume.dropped.get("t_hello")).toBeUndefined();
  });

  test("the daily counter starts over at 00:00 UTC and counts per tenant", async () => {
    const { h, node, hash } = await setup();
    await ingest(h, node, [line(hash, { source: "client" }), line(hash, { source: "client" }), line(hash)]);
    const { clientToday } = logIngest(h.deps);
    expect(clientToday.usedToday("t_hello", h.deps.now())).toBe(2);
    expect(clientToday.usedToday("t_other", h.deps.now())).toBe(0);
    expect(clientToday.usedToday("t_hello", h.deps.now() + 86_400_000)).toBe(0);
  });
});

describe("renox logs against this API", () => {
  test("the CLI shows the lines the API holds, and --source client keeps the browser ones", async () => {
    const { h, token, node, hash } = await setup();
    await ingest(h, node, [line(hash, { message: "from the server" }), line(hash, { source: "client", level: "error", message: "boom" })]);
    const run = async (args: string[]): Promise<string[]> => {
      const out: string[] = [];
      const io: Io = {
        fetch: (url, init) => Promise.resolve(h.app.request(url.replace("https://api.test", ""), init, { requestIP: () => ({ address: "192.0.2.10" }) })),
        sleep: async () => {},
        out: (l) => out.push(l),
        readStdin: async () => "",
        env: { RENOX_TOKEN: token, RENOX_API_URL: "https://api.test", XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")) },
      };
      expect(await renoxLogs(["--app", "hello", ...args], io)).toBe(0);
      return out;
    };
    const all = await run([]);
    expect(all).toHaveLength(2);
    expect(all[0]).toContain("from the server");
    expect(all[1]).toContain("[browser]");
    expect(await run(["--source", "client"])).toHaveLength(1);
  });
});
