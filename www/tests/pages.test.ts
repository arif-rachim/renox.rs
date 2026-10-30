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
import { doc, search, sidebar, slugOfPath, SOURCES } from "../lib/docs.ts";
import { render } from "../lib/markdown.ts";
import { PRICING, withVat } from "../lib/pricing.ts";
import { load as pricingLoad } from "../pages/pricing.ts";

setDefaultTimeout(120_000);
const ROOT = join(import.meta.dir, "../..");
const worker = process.env.RENOX_WORKER_PATH;

describe("documentation", () => {
  test("the site carries every markdown file of docs/ and docs/contracts/", () => {
    const files = [
      ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
      ...readdirSync(join(ROOT, "docs/contracts")).filter((f) => f.endsWith(".md")).map((f) => `docs/contracts/${f}`),
    ].sort();
    expect([...SOURCES.keys()].sort()).toEqual(files);
    for (const f of files) expect(SOURCES.get(f)).toBe(readFileSync(join(ROOT, f), "utf8"));
  });

  test("the sidebar follows AGENTS.md's reading order, then the contracts", () => {
    const s = sidebar();
    expect(s.slice(0, 3).map((d) => d.slug)).toEqual(["00-overview", "01-business", "02-comparison"]);
    expect(s.find((d) => d.slug === "25-execution")).toBeDefined();
    expect(s.at(-1)?.path.startsWith("docs/contracts/")).toBe(true);
    expect(s).toHaveLength(SOURCES.size);
  });

  test("every document renders, and every link to the site lands on a document and its heading", () => {
    const ids = new Map<string, Set<string>>();
    const rendered = sidebar().map((d) => {
      const r = doc(d.slug);
      expect(r, d.path).not.toBeNull();
      ids.set(d.slug, new Set(r?.headings.map((h) => h.id)));
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
    expect(doc("no-such-doc")).toBeNull();
    expect(slugOfPath("docs/contracts/ops.md")).toBe("contracts-ops");
  });

  test("the repository's link check passes (.github/scripts/check-links.ts)", () => {
    const r = Bun.spawnSync(["bun", join(ROOT, ".github/scripts/check-links.ts")], { cwd: ROOT });
    expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);
  });

  test("search by title", () => {
    expect(search("threat").map((d) => d.slug)).toEqual(["24-threat-model"]);
    expect(search("no such title words")).toEqual([]);
  });

  test("the renderer escapes text and passes no raw HTML", () => {
    const r = render('# T <b>\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) `<i>` **b** _e_\n\n| a | b |\n| --- | --- |\n| <img src=x> | 2 |\n');
    expect(r.html).not.toContain("<script");
    expect(r.html).not.toContain("<img");
    expect(r.html).not.toContain("<b>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain("<code>&lt;i&gt;</code>");
    expect(r.html).toContain("<strong>b</strong>");
    expect(r.html).toContain("<em>e</em>");
    expect(r.html).toContain("<td>&lt;img src=x&gt;</td>");
  });
});

describe("pricing and legal", () => {
  test("pricing.toml equals the billing plans; the page shows the VAT-inclusive price", () => {
    expect(PRICING.currency).toBe("AED");
    expect(PRICING.vat_rate).toBe(VAT_RATE);
    expect(PRICING.plans.map((p) => ({ id: p.id, name: p.name, price_month: p.price_month, quotas: p.quotas }))).toEqual(PLANS.map((p) => ({ id: p.id, name: p.name, price_month: p.price_month, quotas: { ...p.quotas } })));
    expect(withVat("79.00", "0.05")).toBe("82.95");
    const page = pricingLoad();
    expect(page.plans[1]).toMatchObject({ name: "Starter", price: "79.00", with_vat: "82.95" });
    expect(page.plans[3]?.quotas[0]).toEqual({ label: "Requests / month", value: "unlimited" });
  });

  test("the legal pages carry the versions sign-up records", () => {
    expect(readFileSync(join(import.meta.dir, "../pages/legal/dpa.html"), "utf8")).toContain(`Version ${DPA_VERSION}.`);
    expect(readFileSync(join(import.meta.dir, "../pages/legal/terms.html"), "utf8")).toContain(`Version ${TERMS_VERSION}.`);
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
    const overview = await get("/docs/00-overview");
    expect(overview.status).toBe(200);
    expect(overview.text).toContain('<a href="/docs/13-decisions" class="">');
    expect(overview.text).toMatch(/<h1 id="[^"]+">/u);
    expect((await get("/docs/no-such-doc")).status).toBe(404);
    expect((await get("/docs?q=threat")).text).toContain('href="/docs/24-threat-model"');
    const pricing = await get("/pricing");
    expect(pricing.text).toContain("AED 82.95 with VAT");
    expect((await get("/legal/dpa")).text).toContain(`Version ${DPA_VERSION}.`);
  } finally {
    await dev.stop();
  }
});
