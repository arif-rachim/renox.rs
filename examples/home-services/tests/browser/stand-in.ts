// STAND-IN, to be removed with #832 (platform gap): a page loader cannot set a response header
// (docs/contracts/ops.md section 14: a loader returns an object or a whole Response), so the app cannot send
// `x-hs-offline-ok: 1` yet and the service worker (public/sw.js) would store nothing. `withLoaderHeader` is a
// small reverse proxy that adds exactly that header to the two day pages; the browser tests that need the
// service worker (offline-read.test.ts #807, offline-queue.test.ts #808) talk to the proxy. Nothing else about
// the worker, me.js or the pages is faked. Delete this file with #832, when the two loaders set the header.

const OFFLINE_OK_PAGE = /^\/me(\/visits\/[^/]+)?$/u;

/**
 * STAND-IN (see the header): a reverse proxy to `upstream` that adds `x-hs-offline-ok: 1` to a 200
 * HTML answer for `/me` and `/me/visits/<id>` only, as the two loaders will when the platform lets a
 * page set a header. Redirects stay redirects; Origin and Referer are rewritten to the upstream's.
 */
export function withLoaderHeader(upstream: string): { port: number; stop: () => void } {
  const up = new URL(upstream);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.delete("host");
      if (headers.has("origin")) headers.set("origin", up.origin);
      if (headers.has("referer")) headers.set("referer", up.origin + new URL(headers.get("referer") as string).pathname + new URL(headers.get("referer") as string).search);
      headers.delete("accept-encoding");
      const res = await fetch(up.origin + url.pathname + url.search, { method: req.method, headers, body: req.body, redirect: "manual" });
      const out = new Headers(res.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      const location = out.get("location");
      if (location) out.set("location", location.replace(up.origin, `http://localhost:${server.port}`));
      if (req.method === "GET" && res.status === 200 && OFFLINE_OK_PAGE.test(url.pathname) && (out.get("content-type") ?? "").startsWith("text/html")) out.set("x-hs-offline-ok", "1");
      return new Response(res.body, { status: res.status, headers: out });
    },
  });
  return { port: server.port as number, stop: () => void server.stop(true) };
}
