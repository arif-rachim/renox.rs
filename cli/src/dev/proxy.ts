// The `renox dev` proxy's view of a worker response (#267). Bun's `fetch`
// decompresses `gzip`, `deflate`, `br` and `zstd` bodies by itself, so the
// bytes it hands over are no longer what `content-encoding` and
// `content-length` describe. Forwarding those headers made the browser try
// to decode plain bytes ("htmx request to a route answering 500" failed in
// Chromium). The body is passed on as a stream, so a streamed response
// (ops.md 1.2.0) still reaches the browser chunk by chunk.

export function decodedResponse(res: Response): Response {
  if (!res.headers.has("content-encoding")) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
