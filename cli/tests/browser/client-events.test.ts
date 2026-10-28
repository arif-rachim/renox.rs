// #127: the client script in headless Chromium against `examples/shop` under
// `renox dev`, with three pages added that fail on purpose. Each scenario
// checks what the developer sees: the `[browser]` terminal line, the line in
// .renox/logs/browser.ndjson (what the MCP tool dev_errors returns), and the
// overlay's Browser tab, which shows the server side of the same request id
// on the same screen.
//
// Runs when RENOX_WORKER_PATH points at a renox-worker binary (cargo build
// -p renox-cell --bin renox-worker) and Playwright is installed
// (PLAYWRIGHT_PATH, else the global `playwright` package with its Chromium).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DevServer, startDev } from "../../src/commands/dev.ts";
import { testWorker } from "../worker-env.ts";

const repo = join(import.meta.dir, "../../..");
const worker = testWorker();

type Pw = { chromium: { launch: () => Promise<Browser> } };
type Browser = { newPage: () => Promise<Page>; close: () => Promise<void> };
type Page = {
  goto: (u: string) => Promise<unknown>;
  click: (s: string) => Promise<void>;
  content: () => Promise<string>;
  waitForFunction: (f: string, arg?: unknown, o?: { timeout: number }) => Promise<unknown>;
  locator: (s: string) => { innerText: (o?: { timeout: number }) => Promise<string>; click: () => Promise<void>; first: () => { click: () => Promise<void>; innerText: (o?: { timeout: number }) => Promise<string> } };
  close: () => Promise<void>;
};
const playwright = ((): Pw | null => {
  const require = createRequire(import.meta.url);
  // `bun test` does not search NODE_PATH: try its entries by hand.
  const candidates = [process.env.PLAYWRIGHT_PATH, "playwright", ...(process.env.NODE_PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "playwright"))];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return require(c) as Pw;
    } catch {
      // next
    }
  }
  return null;
})();

/** Pages added to the shop copy. Their scripts get the CSP nonce from the template compiler. */
const PAGES: Record<string, string> = {
  // An inline script that throws, and one that adds a script without a nonce (blocked by the CSP).
  "pages/client-errors.html": `<r-layout use="main">
  <h1>Client errors</h1>
  <button id="boom" hx-get="/boom" hx-target="#out">boom</button>
  <button id="nowhere" hx-get="/products" hx-target="#missing">nowhere</button>
  <div id="out"></div>
  <script>
    const blocked = document.createElement("script");
    blocked.textContent = "window.notAllowed = 1";
    document.head.append(blocked);
  </script>
  <script>
    window.renoxCart.open();
  </script>
</r-layout>
`,
  // A page route whose loader throws: 500 RENOX_INTERNAL with the error page.
  "pages/boom.html": "<r-layout use=\"main\"><p>{{ x }}</p></r-layout>\n",
  "pages/boom.ts": 'export function load() {\n  throw new Error("boom: the database is down");\n}\n',
};

describe.skipIf(!worker || !playwright)("renox-client.js in Chromium under renox dev", () => {
  let dev: DevServer;
  let dir: string;
  let browser: Browser;
  let base: string;
  const lines: string[] = [];

  /** Waits until a terminal line matches. */
  const line = async (re: RegExp, ms = 8000): Promise<string> => {
    const until = Date.now() + ms;
    for (;;) {
      const l = lines.find((x) => re.test(x));
      if (l) return l;
      if (Date.now() > until) throw new Error(`no terminal line matching ${re}:\n${lines.join("\n")}`);
      await Bun.sleep(50);
    }
  };
  const browserLog = (): { request_id: string | null; fields: { kind: string; detail: Record<string, unknown>; code: string | null } }[] => {
    const p = join(dir, ".renox/logs/browser.ndjson");
    return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "renox-browser-"));
    cpSync(join(repo, "examples/shop"), dir, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".renox") });
    symlinkSync(join(repo, "examples/shop/node_modules"), join(dir, "node_modules"));
    for (const [p, src] of Object.entries(PAGES)) writeFileSync(join(dir, p), src);
    const port = 20000 + Math.floor(Math.random() * 20000);
    dev = await startDev({ project: dir, port, log: (l) => lines.push(l) });
    base = `http://localhost:${port}`;
    browser = await (playwright as Pw).chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await dev?.stop();
  });

  test("every page loads the client script with the nonce, request id, and deployment", async () => {
    const res = await fetch(`${base}/products`);
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/u.exec(res.headers.get("content-security-policy") ?? "")?.[1];
    const id = res.headers.get("x-renox-request-id");
    expect(html).toContain(`<meta name="renox-request-id" content="${id}">`);
    expect(html).toMatch(/<meta name="renox-deployment" content="[0-9a-f]{64}">/u);
    expect(nonce).toBeDefined();
    expect(html).toMatch(/<script nonce="[^"]+" src="\/__renox\/client\.js\?v=[0-9a-f]{16}"><\/script>/u);
    expect(html).toContain(`<script nonce="${nonce}" src="/__renox/client.js?v=`);
    // Dev only: the marker and the Browser tab, before the client script.
    expect(html.indexOf('<meta name="renox-dev"')).toBeLessThan(html.indexOf("/__renox/client.js"));
    expect(res.headers.get("reporting-endpoints")).toBe('renox-csp="/__renox/events?kind=csp"');
  });

  test("an inline script that throws: js.error with the page's file and line", async () => {
    const page = await browser.newPage();
    try {
      const res = await fetch(`${base}/client-errors`);
      const html = await res.text();
      const throwLine = html.split("\n").findIndex((l) => l.includes("window.renoxCart.open()")) + 1;
      expect(throwLine).toBeGreaterThan(0);
      await page.goto(`${base}/client-errors`);
      const l = await line(/^\[browser\] js\.error /u);
      expect(l).toMatch(new RegExp(`^\\[browser\\] js\\.error pages/client-errors\\.html:${throwLine}:\\d+ .*TypeError.* \\([0-9A-Z]{26}\\)$`, "u"));
      const e = browserLog().find((x) => x.fields.kind === "js.error");
      expect(e?.fields.detail).toMatchObject({ source: "/client-errors", line: throwLine });
      expect(e?.request_id).toMatch(/^[0-9A-Z]{26}$/u);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a script blocked by the CSP: csp.violation", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/client-errors`);
      const l = await line(/^\[browser\] csp\.violation script-src-elem blocked inline/u);
      expect(l).toContain("/client-errors");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("htmx request to a route answering 500: htmx.responseError with the RENOX code and the fragment's request id; the overlay shows the server side", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/client-errors`);
      await page.click("#boom");
      const l = await line(/^\[browser\] htmx\.responseError \/boom/u);
      const id = /\(([0-9A-Z]{26})\)/u.exec(l)?.[1] as string;
      expect(l).toContain("500 RENOX_INTERNAL");
      expect(id).toBeDefined();
      const e = browserLog().find((x) => x.fields.kind === "htmx.responseError");
      expect(e).toMatchObject({ request_id: id, fields: { code: "RENOX_INTERNAL", detail: { status: 500, code: "RENOX_INTERNAL", target: "#out", request_url: "/boom" } } });
      // The server log has the same request id.
      const server = readFileSync(join(dir, ".renox/logs/tenant.ndjson"), "utf8");
      expect(server).toContain(`"request_id":"${id}"`);
      // Browser tab: open it, ask for the server log of that request; both on one screen.
      await page.locator("renox-dev-browser div").first().click();
      await page.locator(`renox-dev-browser button:text("Server log for ${id}")`).click();
      await page.waitForFunction("document.querySelector('renox-dev-browser').shadowRoot.textContent.includes('Server: ')", null, { timeout: 5000 });
      const panel = await page.locator("renox-dev-browser div").first().innerText({ timeout: 5000 });
      expect(panel).toContain("htmx.responseError");
      expect(panel).toContain(`Server: renox dev: 500 RENOX_INTERNAL`);
      expect(panel).toContain("hint");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("htmx target that matches nothing: htmx.targetError", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/client-errors`);
      await page.click("#nowhere");
      const l = await line(/^\[browser\] htmx\.targetError /u);
      expect(l).toContain("#missing");
    } finally {
      await page.close();
    }
  }, 30_000);
});
