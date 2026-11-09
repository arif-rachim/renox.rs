// The first hour (#449): what `renox new` prints and writes, a home page that
// answers 200 under `renox dev`, and a `renox dev` terminal without the
// production node's warnings (fetch_blocked_addresses, platform_key_file,
// the disk watermark), other worker lines as one short line each.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDev, workerLine } from "../src/commands/dev.ts";
import { newApp, nextSteps } from "../src/commands/new.ts";
import { testWorker } from "./worker-env.ts";
import { freePort } from "./free-port.ts";

const worker = testWorker();

test("renox new prints every step to a live app, and the docs", () => {
  expect(nextSteps("demo")).toMatchSnapshot();
  const steps = nextSteps("demo");
  for (const s of ["cd demo", "bun install", "renox dev", "renox login", "renox deploy", "https://renoxium.com/docs"]) expect(steps).toContain(s);
});

test("renox new writes a README, a home page with its layout and a test; {{APP}} becomes the name", () => {
  const dir = newApp("first", "hello", mkdtempSync(join(tmpdir(), "renox-first-")));
  for (const f of ["README.md", "pages/index.html", "pages/_layouts/main.html", "tests/hello.test.ts", "functions/api/hello.ts"]) expect([f, existsSync(join(dir, f))]).toEqual([f, true]);
  expect(readFileSync(join(dir, "README.md"), "utf8")).toStartWith("# first\n");
  expect(readFileSync(join(dir, "pages/index.html"), "utf8")).toContain("<h1>first is running</h1>");
  for (const f of ["README.md", "pages/index.html", "functions/api/hello.ts"]) expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/\{\{APP\}\}|benchmark|spike/u);
  const blank = newApp("bare", "blank", mkdtempSync(join(tmpdir(), "renox-first-")));
  expect(existsSync(join(blank, "README.md"))).toBe(true);
});

test("worker lines: node-only messages are dropped, others become one short line", () => {
  const j = (level: string, fields: Record<string, unknown>) => JSON.stringify({ timestamp: "t", level, fields, target: "renox_cell::x" });
  expect(workerLine(j("ERROR", { message: "disk watermark reached", level: "warn", used_pct: 89.1 }))).toBeNull();
  expect(workerLine(j("WARN", { message: "worker degraded", component: "disk", reason: "warn 89% used" }))).toBeNull();
  expect(workerLine(j("WARN", { message: "refused at the disk watermark", tenant_id: "dev" }))).toBeNull();
  // #462: every 5 s on macOS, where the worker has no statvfs probe.
  expect(workerLine(j("WARN", { message: "disk usage unreadable", path: "/Users/dev/app/.renox/data", error: "unsupported" }))).toBeNull();
  expect(workerLine(j("WARN", { message: "isolate restarted", tenant_id: "dev", reason: "cpu limit" }))).toBe('worker: warn isolate restarted tenant_id=dev reason="cpu limit"');
  expect(workerLine("not json")).toBe("worker: not json");
});

test.skipIf(!worker)(
  "a new hello app under renox dev: GET / is 200 and the terminal has no production-node warning",
  async () => {
    const dir = newApp("homepage", "hello", mkdtempSync(join(tmpdir(), "renox-first-")));
    const port = freePort();
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port, log: (l) => lines.push(l) });
    try {
      const home = await fetch(`http://localhost:${port}/`, { headers: { accept: "text/html" } });
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("homepage is running");
      expect((await fetch(`http://localhost:${port}/api/hello`)).status).toBe(200);
      await Bun.sleep(1500);
      const text = lines.join("\n");
      for (const w of ["fetch_blocked_addresses", "platform_key_file", "watermark", '"level":"WARN"']) expect([w, text.includes(w)]).toEqual([w, false]);
      // The dev platform key: written once, 0600, kept across restarts.
      expect(statSync(join(dir, ".renox", "platform.key")).mode & 0o777).toBe(0o600);
    } finally {
      await dev.stop();
    }
  },
  60_000,
);

// #656: a handler that writes to global scope is warned about under renox dev.
test.skipIf(!worker)(
  "renox dev warns about a handler writing globalThis: terminal line per rebuild, overlay badge, cleared when fixed",
  async () => {
    const dir = newApp("warned", "hello", mkdtempSync(join(tmpdir(), "renox-first-")));
    const file = join(dir, "functions/api/hello.ts");
    const clean = readFileSync(file, "utf8");
    const dirty = `${clean}\nexport const POST = ((_ctx: Pick<Ctx, "req">) => {\n  globalThis.counter = 1;\n  return Response.json({ ok: true });\n}) satisfies Handler;\n`;
    writeFileSync(file, dirty);
    const at = dirty.split("\n").findIndex((l) => l.includes("globalThis.counter")) + 1;
    const port = freePort();
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port, log: (l) => lines.push(l) });
    const home = async (): Promise<string> => (await fetch(`http://localhost:${port}/`, { headers: { accept: "text/html" } })).text();
    const warns = (): string[] => lines.filter((l) => l.startsWith("warn: "));
    const line = `warn: functions/api/hello.ts:${at} handler writes to global scope (globalThis.counter); state does not survive an isolate restart (docs/07)`;
    try {
      expect(warns()).toEqual([line]);
      expect(await home()).toContain("/__renox/dev/warnings-badge.js");
      expect(await (await fetch(`http://localhost:${port}/__renox/dev/warnings`)).json()).toEqual([{ file: "functions/api/hello.ts", line: at, name: "globalThis.counter" }]);
      expect(await (await fetch(`http://localhost:${port}/__renox/dev/warnings-badge.js`)).text()).toContain("warnings (");

      // Another save: the warning is printed again, once.
      let reload = dev.nextReload();
      writeFileSync(file, `${dirty}// touched\n`);
      await reload;
      expect(warns()).toEqual([line, line]);

      // Fixed: the list and the badge are gone.
      reload = dev.nextReload();
      writeFileSync(file, clean);
      await reload;
      expect(warns().length).toBe(2);
      expect(await (await fetch(`http://localhost:${port}/__renox/dev/warnings`)).json()).toEqual([]);
      expect(await home()).not.toContain("warnings-badge");
    } finally {
      await dev.stop();
    }
  },
  60_000,
);

test.skipIf(!worker)(
  "a clean hello app under renox dev has no warn line and no badge",
  async () => {
    const dir = newApp("tidy", "hello", mkdtempSync(join(tmpdir(), "renox-first-")));
    const port = freePort();
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port, log: (l) => lines.push(l) });
    try {
      const html = await (await fetch(`http://localhost:${port}/`, { headers: { accept: "text/html" } })).text();
      expect(html).not.toContain("warnings-badge");
      expect(lines.filter((l) => l.startsWith("warn: "))).toEqual([]);
    } finally {
      await dev.stop();
    }
  },
  60_000,
);

test("docs/12 lists only templates and commands that exist (no shop, saas or db shell)", () => {
  const doc = readFileSync(join(import.meta.dir, "../../docs/12-developer-experience.md"), "utf8");
  const row = doc.split("\n").find((l) => l.startsWith("| `renox new <name>`")) ?? "";
  const named = [...row.matchAll(/`([a-z]+)`/gu)].map((m) => m[1] as string);
  const templates = Object.keys(cliTemplates());
  expect(named.length).toBeGreaterThan(0);
  for (const n of named) expect(templates).toContain(n);
  expect(doc).not.toMatch(/`(shop|saas)`.*template|template.*`(shop|saas)`|renox db shell/u);
});

function cliTemplates(): Record<string, unknown> {
  return Object.fromEntries(readdirSync(join(import.meta.dir, "../templates"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => [d.name, true]));
}
