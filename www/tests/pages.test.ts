// The public site (#326): every document of docs/ renders, every link it
// makes to the site lands on a document (and its heading), the repository's
// own link check passes, the renderer passes no raw HTML, the pricing page's
// plans equal the billing plans, and the legal pages carry the versions
// sign-up records. With RENOX_WORKER_PATH the site is built, checked and
// served by the worker.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PLANS, VAT_RATE } from "@renox/billing";

import { DPA_VERSION, TERMS_VERSION } from "../../control/api/src/signup/dpa.ts";
import { buildArtifact } from "../../cli/src/lib/build.ts";
import { check } from "../../cli/src/commands/check.ts";
import { startDev } from "../../cli/src/commands/dev.ts";
import { doc, nav, PUBLISHED, search, slugOfPath, SOURCES } from "../lib/docs.ts";
import { render } from "../lib/markdown.ts";
import { PRICING, withVat } from "../lib/pricing.ts";
import { contrastFailures, loadsAnything, physicalLines } from "../../packages/ui/lint.ts";
import { dotField, features, load as homeLoad, STATS } from "../pages/index.ts";
import { load as pricingLoad } from "../pages/pricing.ts";

setDefaultTimeout(120_000);
const ROOT = join(import.meta.dir, "../..");
const worker = process.env.RENOX_WORKER_PATH;

describe("documentation", () => {
  /** The files of docs/ the site must never serve (#428): internal planning and security material. */
  const INTERNAL = ["01-business", "02-comparison", "03-architecture", "04-isolation-security", "13-decisions", "14-benchmarks", "15-roadmap", "16-risks", "18-build-plan", "19-platform-wireframes", "21-uae-gcc-strategy", "22-development-plan", "23-failure-modes", "24-threat-model", "25-execution", "contracts-deploy-api"];

  test("the site serves only the allowlist: every other markdown file of docs/ is 404 and not bundled", () => {
    const published = new Set(PUBLISHED.map((p) => p.path));
    const files = [
      ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
      ...readdirSync(join(ROOT, "docs/contracts")).filter((f) => f.endsWith(".md")).map((f) => `docs/contracts/${f}`),
    ];
    for (const f of files) {
      const slugs = [f.replace(/^docs\//u, "").replace(/\.md$/u, "").replace(/\//gu, "-"), f.replace(/^docs\/(?:contracts\/)?(?:\d+-)?/u, "").replace(/\.md$/u, "")];
      if (f === "docs/contracts/ops.md") {
        // Only its section 10 is a page (/docs/limits); the whole contract is not served.
        for (const slug of slugs) expect(doc(slug), slug).toBeNull();
      } else if (published.has(f)) {
        expect(SOURCES.get(f), f).toBe(readFileSync(join(ROOT, f), "utf8"));
        expect(doc(slugOfPath(f) as string), f).not.toBeNull();
      } else {
        for (const slug of slugs) expect(doc(slug), `${f} must not be served as /docs/${slug}`).toBeNull();
        expect(slugOfPath(f), f).toBeNull();
        expect(SOURCES.has(f), f).toBe(false);
      }
    }
    for (const slug of INTERNAL) expect(doc(slug), slug).toBeNull();
    // What the issue lists as published is published, under a clean slug.
    expect(PUBLISHED.map((p) => p.slug)).toEqual(["getting-started", "tutorial", "tutorial-install", "tutorial-dev-loop", "tutorial-pages", "tutorial-data", "tutorial-actions", "tutorial-teams", "tutorial-authorization", "tutorial-realtime", "tutorial-tests", "tutorial-deploy", "developer-experience", "app-model", "data", "templates", "realtime", "modules", "authorization", "ai-agents-mcp", "cli", "sdk", "ctx", "errors", "manifest", "limits", "overview", "tenant-lifecycle", "glossary"]);
    // Nothing bundled is internal: the imports of lib/docs.ts are the allowlist.
    const imports = [...readFileSync(join(import.meta.dir, "../lib/docs.ts"), "utf8").matchAll(/from "\.\.\/\.\.\/([^"]+)" with \{ type: "text" \}/gu)].map((m) => m[1] as string);
    expect(imports.sort()).toEqual([...new Set(PUBLISHED.map((p) => p.path))].sort());
    for (const i of imports) expect(INTERNAL.some((x) => i.includes(x.replace("contracts-", "contracts/"))), i).toBe(false);
  });

  test("the navigation is grouped, marks the current page, and gives previous and next", () => {
    expect(nav("data").map((g) => g.group)).toEqual(["Get started", "Guides", "Reference", "Concepts"]);
    const guides = nav("data").find((g) => g.group === "Guides") as { items: { label: string; current: boolean; href: string }[] };
    expect(guides.items.filter((i) => i.current).map((i) => i.label)).toEqual(["Data"]);
    expect(guides.items.map((i) => i.label)).toEqual(["App model", "Data", "Templates", "Fragments and realtime", "Modules", "Authorization", "Custom domains", "AI agents and MCP"]);
    expect(guides.items.find((i) => i.label === "Custom domains")?.href).toBe("/docs/tenant-lifecycle#custom-domains-and-dns");
    const d = doc("data") as NonNullable<ReturnType<typeof doc>>;
    expect(d.title).toBe("Data");
    expect(d.previous).toEqual({ label: "App model", href: "/docs/app-model" });
    expect(d.next).toEqual({ label: "Templates", href: "/docs/templates" });
    expect(d.contents.map((c) => c.text)).toContain("Why SQLite per tenant");
    expect((doc("getting-started") as NonNullable<ReturnType<typeof doc>>).previous).toBeNull();
    expect((doc("glossary") as NonNullable<ReturnType<typeof doc>>).next).toBeNull();
    // Numbers and file names are gone from titles.
    for (const p of PUBLISHED) expect((doc(p.slug) as NonNullable<ReturnType<typeof doc>>).title).not.toMatch(/^\d|\.md/u);
    expect((doc("limits") as NonNullable<ReturnType<typeof doc>>).title).toBe("Limits per tier and behaviour on limit");
    expect((doc("ctx") as NonNullable<ReturnType<typeof doc>>).html).toContain("export type DbErrorCode");
  });

  test("every page renders, and every link to the site lands on a page and its heading", () => {
    const ids = new Map<string, Set<string>>();
    const rendered = PUBLISHED.map((p) => {
      const r = doc(p.slug);
      expect(r, p.path).not.toBeNull();
      ids.set(p.slug, new Set(r?.headings.map((h) => h.id)));
      return r as NonNullable<ReturnType<typeof doc>>;
    });
    const broken: string[] = [];
    for (const r of rendered) {
      expect(r.html, r.path).toContain("<h1 id=");
      expect(r.title.length, r.path).toBeGreaterThan(0);
      for (const m of r.html.matchAll(/href="\/docs\/([^"#]+)(?:#([^"]+))?"/gu)) {
        const [slug, anchor] = [m[1] as string, m[2]];
        if (!ids.has(slug)) broken.push(`${r.path}: /docs/${slug}`);
        else if (anchor !== undefined && !ids.get(slug)?.has(decodeURIComponent(anchor))) broken.push(`${r.path}: /docs/${slug}#${anchor}`);
      }
      for (const m of r.html.matchAll(/href="([^"]+)"/gu)) {
        const href = m[1] as string;
        if (!/^(\/docs\/|https?:|mailto:|#)/u.test(href)) broken.push(`${r.path}: ${href}`);
      }
    }
    expect(broken).toEqual([]);
    for (const [, items] of nav(null).map((g) => [g.group, g.items] as const)) {
      for (const i of items) {
        const [slug, anchor] = i.href.replace("/docs/", "").split("#");
        expect(ids.has(slug as string), i.href).toBe(true);
        if (anchor !== undefined) expect(ids.get(slug as string)?.has(anchor), i.href).toBe(true);
      }
    }
    expect(doc("no-such-doc")).toBeNull();
    expect(slugOfPath("docs/contracts/errors.md")).toBe("errors");
  });

  test("the repository's link check passes (.github/scripts/check-links.ts)", () => {
    const r = Bun.spawnSync(["bun", join(ROOT, ".github/scripts/check-links.ts")], { cwd: ROOT });
    expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);
  });

  test("search by title and by section, with the section shown", () => {
    expect(search("glossary").map((h) => h.slug)).toEqual(["glossary"]);
    const hits = search("custom domains");
    expect(hits.some((h) => h.slug === "tenant-lifecycle" && h.section?.href === "/docs/tenant-lifecycle#custom-domains-and-dns")).toBe(true);
    expect(search("threat model")).toEqual([]);
    expect(search("no such title words")).toEqual([]);
    expect(search("")).toEqual([]);
  });

  test("the renderer escapes text and passes no raw HTML, and names a code block's language", () => {
    const r = render('# T <b>\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) `<i>` **b** _e_\n\n| a | b |\n| --- | --- |\n| <img src=x> | 2 |\n\n```sh\nls\n```\n');
    expect(r.html).not.toContain("<script");
    expect(r.html).not.toContain("<img");
    expect(r.html).not.toContain("<b>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain("<code>&lt;i&gt;</code>");
    expect(r.html).toContain("<strong>b</strong>");
    expect(r.html).toContain("<em>e</em>");
    expect(r.html).toContain("<td>&lt;img src=x&gt;</td>");
    expect(r.html).toContain('<pre data-lang="sh"><code class="language-sh">ls</code></pre>');
  });
});

describe("pricing and legal", () => {
  test("pricing.toml equals the billing plans; the page shows the VAT-inclusive price", () => {
    expect(PRICING.currency).toBe("AED");
    expect(PRICING.vat_rate).toBe(VAT_RATE);
    expect(PRICING.plans.map((p) => ({ id: p.id, name: p.name, price_month: p.price_month, quotas: p.quotas }))).toEqual(PLANS.map((p) => ({ id: p.id, name: p.name, price_month: p.price_month, quotas: { ...p.quotas } })));
    expect(withVat("79.00", "0.05")).toBe("82.95");
    const page = pricingLoad();
    expect(page.plans[1]).toMatchObject({ name: "Starter", price: "79", with_vat: "82.95" });
    expect(page.plans[3]?.quotas[0]).toEqual({ label: "Requests / month", value: "unlimited" });
  });

  test("the landing page's dot fields: a fixed pattern of safe glyphs, a few lit; its numbers are measured ones", () => {
    const f = features();
    expect(f.map((x) => x.id)).toEqual(["modules", "runs", "domains", "agents"]);
    for (const x of f) {
      // Drawn, not typed: an inline SVG of circles and rects only, two of them lit.
      expect(x.dots.startsWith("<svg ")).toBe(true);
      expect(x.dots.replace(/<svg [^>]*>|<\/svg>|<circle [^>]*\/>|<rect [^>]*\/>/gu, "")).toBe("");
      expect(x.dots.match(/class="lit"/gu)?.length).toBe(2);
      expect(x.href.startsWith("/docs/")).toBe(true);
    }
    expect(features()).toEqual(f);
    expect(dotField(2, 1, [], [1])).toBe('<svg viewBox="0 0 40 20" xmlns="http://www.w3.org/2000/svg" focusable="false"><circle class="dot-idle" cx="10" cy="10" r="1.6"/><rect class="lit" x="24" y="4" width="12" height="12" rx="2"/></svg>');
    // Every feature headline stays short enough for two lines on a phone (taste review, #428).
    for (const x of f) expect(`${x.head} ${x.muted}`.length, x.id).toBeLessThanOrEqual(52);
    // Every stat is a whole number (Doto draws a period as a cross) with its source named.
    for (const s of STATS) {
      expect(s.value).toMatch(/^\d+$/u);
      expect(readFileSync(join(ROOT, s.source), "utf8").length).toBeGreaterThan(0);
    }
    const bench = readFileSync(join(ROOT, "docs/14-benchmarks.md"), "utf8");
    expect(bench).toContain("0.107 MB with 500 tenants");
    expect(bench).toContain("p99 45.4 ms");
  });

  test("the landing page's plan summary is pricing.toml's", () => {
    const home = homeLoad();
    expect(home.currency).toBe(PRICING.currency);
    expect(home.plans.map((p) => [p.name, p.price])).toEqual(PRICING.plans.map((p) => [p.name, p.price_month.replace(/\.00$/u, "")]));
    expect(home.plans[0]).toMatchObject({ name: "Free", free: true, requests: "100,000", apps: "2", db: "100 MB" });
    expect(home.plans.filter((p) => p.free)).toHaveLength(1);
    // An unlimited quota (-1 in pricing.toml) reads "unlimited", never 0.
    expect(home.plans.at(-1)).toMatchObject({ name: "Agency", requests: "unlimited", apps: "unlimited" });
  });

  test("the legal pages carry the versions sign-up records", () => {
    expect(readFileSync(join(import.meta.dir, "../pages/legal/dpa.html"), "utf8")).toContain(`Version ${DPA_VERSION}.`);
    expect(readFileSync(join(import.meta.dir, "../pages/legal/terms.html"), "utf8")).toContain(`Version ${TERMS_VERSION}.`);
  });
});

describe("design system (packages/ui/README.md)", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

  test("public/renox-ui.css is packages/ui/renox-ui.css, unchanged, and loads before site.css", () => {
    expect(read("public/renox-ui.css")).toBe(readFileSync(join(ROOT, "packages/ui/renox-ui.css"), "utf8"));
    const layout = read("pages/_layouts/main.html");
    expect(layout.indexOf('href="/renox-ui.css"')).toBeGreaterThan(-1);
    expect(layout.indexOf('href="/site.css"')).toBeGreaterThan(layout.indexOf('href="/renox-ui.css"'));
  });

  test("site.css uses no physical direction and loads nothing", () => {
    const css = read("public/site.css");
    expect(physicalLines(css)).toEqual([]);
    expect(loadsAnything(css)).toBe(false);
  });

  /** ADR D27: the display font and its licence are the system's copies; the tokens keep WCAG 2.2 AA. */
  test("the display font, its licence and the contrast of the tokens", () => {
    const bytes = (p: string) => readFileSync(join(import.meta.dir, "..", p));
    expect(bytes("public/doto-black.woff2")).toEqual(readFileSync(join(ROOT, "packages/ui/doto-black.woff2")));
    expect(read("public/doto-OFL.txt")).toBe(readFileSync(join(ROOT, "packages/ui/doto-OFL.txt"), "utf8"));
    expect(bytes("public/doto-black.woff2").byteLength).toBeLessThanOrEqual(40 * 1024);
    expect(contrastFailures(read("public/renox-ui.css"))).toEqual([]);
  });
});

test.skipIf(!worker)("renox build and check pass; the worker serves the docs, search, pricing and the legal pages", async () => {
  const app = join(import.meta.dir, "..");
  const out = mkdtempSync(join(tmpdir(), "renox-www-"));
  const built = await buildArtifact(app, out);
  expect(built.manifest.routes.map((r) => ("path" in r ? r.path : "")).sort()).toEqual(["/", "/docs", "/docs/:slug", "/legal/dpa", "/legal/terms", "/pricing"]);
  expect(await check(app)).toEqual({ errors: [], findings: [] });
  const port = 21000 + Math.floor(Math.random() * 9000);
  const dev = await startDev({ project: app, port, log: () => {} });
  try {
    const base = `http://localhost:${port}`;
    const get = async (path: string) => {
      const r = await fetch(`${base}${path}`);
      return { status: r.status, text: (await r.text()).replaceAll(' dir="auto"', "") };
    };
    const data = await get("/docs/data");
    expect(data.status).toBe(200);
    expect(data.text).toContain('href="/docs/data" class="current"');
    expect(data.text).toMatch(/<h1 id="[^"]+">Data<\/h1>/u);
    expect(data.text).toContain('<p class="side-group">Guides</p>');
    expect(data.text).toContain("On this page");
    expect(data.text).toContain('href="/docs/templates"');
    // No file name on the page: the path appears only in the "Source on GitHub" link.
    expect(data.text.replace(/<a href="https:\/\/github\.com[^"]*">Source on GitHub<\/a>/u, "")).not.toContain("06-data.md");
    expect((await get("/docs/no-such-doc")).status).toBe(404);
    // #447: a browser gets the site's HTML 404 page; a client without text/html gets JSON.
    const missing = await fetch(`${base}/no/such/page`, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toStartWith("text/html");
    expect(await missing.text()).toContain("There is no page at this address.");
    expect((await fetch(`${base}/no/such/page`, { headers: { accept: "*/*" } })).headers.get("content-type")).toStartWith("application/json");
    // The allowlist (#428): internal documents answer 404 under every slug they could have had.
    for (const path of ["/docs/24-threat-model", "/docs/threat-model", "/docs/13-decisions", "/docs/01-business", "/docs/25-execution", "/docs/contracts-deploy-api", "/docs/deploy-api"]) expect((await get(path)).status, path).toBe(404);
    expect((await get("/docs?q=custom%20domains")).text).toContain('href="/docs/tenant-lifecycle#custom-domains-and-dns"');
    expect((await get("/docs?q=threat")).text).toContain("No title or section matches.");
    const home = await get("/");
    expect(home.status).toBe(200);
    expect(home.text).toMatch(/<h1 id="hero-title" class="dot">Deploy\. Run\.<\/h1>/u);
    expect(home.text).toContain('<div class="dots" aria-hidden="true"><svg ');
    // Four interface fragments of the product (data-ui), one per feature section.
    expect(home.text.match(/class="ui-frag" data-ui/gu)?.length).toBe(4);
    // No script of the site's own (renox dev injects its own, under /__renox/).
    expect(home.text.match(/<script[^>]*src="([^"]+)"/gu)?.every((m) => m.includes("/__renox/"))).toBe(true);
    expect(home.text).not.toContain("site.js");
    expect(home.text).toContain('href="https://dashboard.renoxium.com/signup"');
    expect(home.text).toContain("AED</small>79");
    const pricing = await get("/pricing");
    expect(pricing.text).toContain("AED 82.95 with VAT");
    expect((await get("/legal/dpa")).text).toContain(`Version ${DPA_VERSION}.`);
  } finally {
    await dev.stop();
  }
});
