// What the dashboard tells a developer to type works as printed (#447): the
// CLI install line from the `cli-v*` release (npm has no package `renox`,
// D28), only the starters `renox new --template` writes, "Docs" in the
// navigation, and the HTML 404 page for a browser.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { TEMPLATES } from "../pages/apps/new.ts";
import { CLI_VERSION, DOCS_URL, INSTALL_URL } from "../lib/install.ts";
import { devWithData } from "./helpers.ts";

const ROOT = join(import.meta.dir, "../../..");
const worker = process.env.RENOX_WORKER_PATH;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules" || n === ".renox" || n === "tests") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(html|ts|md|json|js)$/u.test(n) ? [p] : [];
  });
}

test("no page of the dashboard or the site says `bunx renox` or `npx renox`", () => {
  const bad = [...files(join(ROOT, "control/dashboard")), ...files(join(ROOT, "www"))].filter((f) => !f.endsWith("lib/install.ts") && /\b(bunx|npx) renox\b/u.test(readFileSync(f, "utf8")));
  expect(bad.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
});

test("the install line is the release of the CLI in this repository", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "cli/package.json"), "utf8")) as { version: string };
  expect(CLI_VERSION).toBe(pkg.version);
  expect(INSTALL_URL).toBe(`https://github.com/arif-rachim/renox.rs/releases/download/cli-v${pkg.version}/install.sh`);
  for (const page of ["pages/index.html", "pages/apps/new.html", "pages/signup/verify.html"]) {
    expect([page, readFileSync(join(import.meta.dir, "..", page), "utf8").includes("{{ install_url }} | sh")]).toEqual([page, true]);
  }
});

test("/apps/new offers only starters that `renox new --template` accepts", () => {
  expect(TEMPLATES.length).toBeGreaterThan(0);
  // The CLI's templates are the folders of cli/templates (cli/src/lib/templates.ts).
  const cli = readdirSync(join(ROOT, "cli/templates")).filter((n) => statSync(join(ROOT, "cli/templates", n)).isDirectory());
  for (const t of TEMPLATES) expect(cli).toContain(t.id);
  expect(TEMPLATES.map((t) => t.name)).not.toContain("Blank");
});

test("the navigation links the documentation, signed in and signed out", () => {
  const layout = readFileSync(join(import.meta.dir, "../pages/_layouts/main.html"), "utf8");
  expect(layout.split(`href="${DOCS_URL}"`).length - 1).toBe(2);
});

test.skipIf(!worker)("an unknown URL: a browser gets the HTML 404 page, a client without text/html gets JSON", async () => {
  const dev = await devWithData({});
  try {
    const html = await fetch(`${dev.base}/no/such/page`, { headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" } });
    expect(html.status).toBe(404);
    expect(html.headers.get("content-type")).toStartWith("text/html");
    const body = await html.text();
    expect(body).toContain("Not found");
    expect(body).toContain('href="/apps"');
    const json = await fetch(`${dev.base}/no/such/page`, { headers: { accept: "*/*" } });
    expect(json.status).toBe(404);
    expect(json.headers.get("content-type")).toStartWith("application/json");
  } finally {
    await dev.stop();
  }
});
