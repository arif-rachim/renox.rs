// Runs one Lighthouse audit through its Node API, in Node (Lighthouse targets
// Node; run.ts is Bun). Usage: node lh-node.mjs '<json args>', where the args are
// { url, port, headers, out, categories }. Writes the report JSON to `out`.
import { writeFileSync } from "node:fs";
import lighthouse from "lighthouse";

const { url, port, headers, out, categories } = JSON.parse(process.argv[2]);
// extraHeaders reach the page, not a service worker. A page that registers one
// (the technician pages do) would be fetched by it on later runs without the
// Cookie header and answered 403. So the cookies are also put in the browser's
// own jar (Lighthouse does not clear cookies), which the worker's fetch sends (the
// session cookies are __Host- ones: Secure, which Chrome accepts on localhost).
if (headers && headers.Cookie) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cookies = headers.Cookie.split("; ").map((c) => ({ name: c.slice(0, c.indexOf("=")), value: c.slice(c.indexOf("=") + 1), url: new URL(url).origin, secure: true }));
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    const timer = setTimeout(() => reject(new Error("could not set the cookies in the browser")), 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Storage.setCookies", params: { cookies } }));
    ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id === 1) { clearTimeout(timer); ws.close(); d.error ? reject(new Error(d.error.message)) : resolve(); } };
    ws.onerror = () => reject(new Error("could not set the cookies in the browser"));
  });
}
const result = await lighthouse(url, {
  port,
  output: "json",
  logLevel: "error",
  onlyCategories: categories,
  extraHeaders: headers,
});
if (!result) throw new Error("lighthouse returned no result");
writeFileSync(out, typeof result.report === "string" ? result.report : JSON.stringify(result.report));
