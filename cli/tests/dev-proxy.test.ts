// #267: the `renox dev` proxy passes on a worker response that Bun's
// `fetch` has already decompressed without its `content-encoding` and
// `content-length`, so the browser reads the body as sent; a streamed
// response (ops.md 1.2.0) still streams. The Chromium end of it is
// "htmx request to a route answering 500" in tests/browser.
import { afterAll, expect, test } from "bun:test";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { decodedResponse } from "../src/dev/proxy.ts";

const ERROR_BODY = JSON.stringify({ error: { code: "RENOX_INTERNAL", request_id: "01J0000000000000000000000A", message: "Internal error." } });

const upstream = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/br") return new Response(brotliCompressSync(ERROR_BODY), { status: 500, headers: { "content-type": "application/json", "content-encoding": "br" } });
    if (path === "/gzip") return new Response(gzipSync(ERROR_BODY), { status: 500, headers: { "content-type": "text/html", "content-encoding": "gzip" } });
    if (path === "/plain") return new Response("plain", { headers: { "content-type": "text/plain" } });
    // Two chunks 300 ms apart.
    const stream = new ReadableStream({
      async start(c) {
        c.enqueue(new TextEncoder().encode("first;"));
        await Bun.sleep(300);
        c.enqueue(new TextEncoder().encode("second"));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/plain" } });
  },
});
afterAll(() => upstream.stop(true));
const at = (path: string) => fetch(`http://127.0.0.1:${upstream.port}${path}`, { headers: { "accept-encoding": "br, gzip" } });

test("a Brotli or gzip 500 is readable after the proxy: no content-encoding, no stale content-length", async () => {
  for (const path of ["/br", "/gzip"]) {
    const res = decodedResponse(await at(path));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = await res.text();
    expect(body).toBe(ERROR_BODY);
    const length = res.headers.get("content-length");
    expect(length === null || Number(length) === new TextEncoder().encode(body).length).toBe(true);
  }
});

test("an uncompressed response passes through unchanged", async () => {
  const res = await at("/plain");
  expect(decodedResponse(res)).toBe(res);
});

test("a streamed response still streams: the first chunk arrives before the second is written", async () => {
  const t0 = performance.now();
  const reader = (decodedResponse(await at("/stream")).body as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  const firstAt = performance.now() - t0;
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  expect(new TextDecoder().decode(first.value)).toBe("first;");
  expect(rest).toBe("second");
  expect(firstAt).toBeLessThan(250);
});
