// The first hour (#449): what `renox new` prints and writes, a home page that
// answers 200 under `renox dev`, and a `renox dev` terminal without the
// production node's warnings (fetch_blocked_addresses, platform_key_file,
// the disk watermark), other worker lines as one short line each.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDev, workerLine } from "../src/commands/dev.ts";
import { newApp, nextSteps } from "../src/commands/new.ts";
import { testWorker } from "./worker-env.ts";

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
  expect(workerLine(j("WARN", { message: "isolate restarted", tenant_id: "dev", reason: "cpu limit" }))).toBe('worker: warn isolate restarted tenant_id=dev reason="cpu limit"');
  expect(workerLine("not json")).toBe("worker: not json");
});

test.skipIf(!worker)(
  "a new hello app under renox dev: GET / is 200 and the terminal has no production-node warning",
  async () => {
    const dir = newApp("homepage", "hello", mkdtempSync(join(tmpdir(), "renox-first-")));
    const port = 20000 + Math.floor(Math.random() * 20000);
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
