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
import { ALTERNATIVES, ASKS, CONVERSATION, countText, load as homeLoad, NOT_FOR, STATS } from "../pages/index.ts";
import { API_ORIGIN, LINKS, SITE_ORIGIN, WAITLIST_FORM, whatsappLink } from "../lib/contact.ts";
import { stateOf } from "../pages/thanks.ts";
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
    expect(PUBLISHED.map((p) => p.slug)).toEqual(["getting-started", "tutorial", "tutorial-install", "tutorial-dev-loop", "tutorial-pages", "tutorial-data", "tutorial-actions", "tutorial-teams", "tutorial-authorization", "tutorial-realtime", "tutorial-tests", "tutorial-deploy", "developer-experience", "app-model", "data", "templates", "realtime", "modules", "authorization", "ai-agents-mcp", "reference-app", "cli", "sdk", "ctx", "errors", "manifest", "limits", "overview", "tenant-lifecycle", "glossary"]);
    // Nothing bundled is internal: the imports of lib/docs.ts are the allowlist.
    const imports = [...readFileSync(join(import.meta.dir, "../lib/docs.ts"), "utf8").matchAll(/from "\.\.\/\.\.\/([^"]+)" with \{ type: "text" \}/gu)].map((m) => m[1] as string);
    expect(imports.sort()).toEqual([...new Set(PUBLISHED.map((p) => p.path))].sort());
    for (const i of imports) expect(INTERNAL.some((x) => i.includes(x.replace("contracts-", "contracts/"))), i).toBe(false);
  });

  test("the navigation is grouped, marks the current page, and gives previous and next", () => {
    expect(nav("data").map((g) => g.group)).toEqual(["Get started", "Guides", "Reference", "Concepts"]);
    const guides = nav("data").find((g) => g.group === "Guides") as { items: { label: string; current: boolean; href: string }[] };
    expect(guides.items.filter((i) => i.current).map((i) => i.label)).toEqual(["Data"]);
    expect(guides.items.map((i) => i.label)).toEqual(["App model", "Data", "Templates", "Fragments and realtime", "Modules", "Authorization", "Custom domains", "AI agents and MCP", "Reference app"]);
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

  test("the landing page's numbers are measured ones, each with its source and its link", () => {
    expect(STATS.map((x) => `${x.value} ${x.unit}`)).toEqual(["107 KB", "45 ms", "1 step"]);
    for (const x of STATS) {
      expect(x.value).toMatch(/^\d+$/u);
      expect(readFileSync(join(ROOT, x.source), "utf8").length).toBeGreaterThan(0);
      // The sentence of the deck carries the figure it shows.
      expect(x.text).toContain(x.value === "1" ? "one step" : `${x.value} ${x.unit}`);
    }
    expect(STATS.filter((x) => x.source === "docs/14-benchmarks.md").every((x) => x.href === LINKS.benchmarks && x.link === "How we measured it")).toBe(true);
    expect(LINKS.benchmarks).toEndWith("/docs/14-benchmarks.md");
    const bench = readFileSync(join(ROOT, "docs/14-benchmarks.md"), "utf8");
    expect(bench).toContain("0.107 MB with 500 tenants");
    expect(bench).toContain("p99 45.4 ms");
  });

  test("the landing page's plans are pricing.toml's, Starter recommended, each line's numbers read from it", () => {
    const home = homeLoad();
    expect(home.currency).toBe(PRICING.currency);
    expect(home.plans.map((p) => [p.name, p.price])).toEqual(PRICING.plans.map((p) => [p.name, p.price_month.replace(/\.00$/u, "")]));
    expect(home.plans.filter((p) => p.recommended).map((p) => p.name)).toEqual(["Starter"]);
    expect(home.plans.map((p) => p.text)).toEqual([
      "Your app at <name>.renoxium.app: 2 apps, 100,000 visits and actions a month, 100 MB of data. Set up with us by hand.",
      "Your own web address (up to 3), 5 apps, 2 million visits and actions, 1 GB of data, 10 GB of files, AI help included.",
      "20 apps, 20 addresses, 20 million visits and actions, 10 GB of data, 50 GB of files.",
      "For agencies: unlimited apps and visits, 100 addresses, a workspace per client, your own brand on it.",
    ]);
    expect([countText(null), countText(100_000), countText(2_000_000), countText(2_500_000)]).toEqual(["unlimited", "100,000", "2 million", "2,500,000"]);
  });

  test("the landing page's conversation, asks, alternatives and contact links", () => {
    expect(CONVERSATION.map((t) => t.who)).toEqual(["owner", "renoxium", "owner", "renoxium", "owner", "renoxium"]);
    expect(CONVERSATION.map((t) => t.text).join(" ")).toContain("coolair.renoxium.app");
    expect(ASKS).toHaveLength(4);
    expect(ALTERNATIVES).toHaveLength(4);
    expect(NOT_FOR).toHaveLength(4);
    expect(LINKS.signIn).toBe("https://dashboard.renoxium.com/signin");
    expect(LINKS.connectorList).toBe("mailto:support@renoxium.com?subject=Connector%20list");
    expect(LINKS.takeAway).toEndWith("/issues/668");
    // No number given yet: the WhatsApp buttons write a mail instead of pointing at a number nobody answers.
    expect(whatsappLink(null)).toBe("mailto:support@renoxium.com?subject=WhatsApp%20setup");
    expect(whatsappLink("+971 50 123 4567")).toBe("https://wa.me/971501234567");
    expect(() => whatsappLink("call us")).toThrow();
  });

  test("the waitlist form (#691): four fields, posted to the API, back to /thanks on the site's own origin", () => {
    const page = readFileSync(join(import.meta.dir, "../pages/index.html"), "utf8");
    const form = page.slice(page.indexOf("<form "), page.indexOf("</form>"));
    expect(form).toContain('method="post" :action="links.waitlist"');
    const names = [...form.matchAll(/<input [^>]*name="([a-z_]+)"/gu)].map((m) => m[1]);
    expect(names).toEqual(["email", "interest", "locale", "return_to"]);
    expect(form).toMatch(/name="email" type="email" required/u);
    expect(form).toContain('name="interest" value="connector"');
    expect(form).toContain('name="locale" value="en"');
    expect(form).toContain(':value="links.waitlistReturn"');
    expect(LINKS.waitlist).toBe(`${API_ORIGIN}/v1/waitlist`);
    expect(new URL(LINKS.waitlistReturn).origin).toBe(SITE_ORIGIN);
    expect(new URL(LINKS.waitlistReturn).pathname).toBe("/thanks");
    // The site's CSP allows the post to the API (renox.toml form_action, #740), so the ask is the form.
    expect(homeLoad().waitlistForm).toBe(WAITLIST_FORM);
  });

  test("/thanks has three states, read from the query the API sets", () => {
    expect(stateOf(new URLSearchParams("confirmed=1&list=connector"))).toBe("confirmed");
    expect(stateOf(new URLSearchParams("confirmed=0"))).toBe("invalid");
    expect(stateOf(new URLSearchParams("list=connector"))).toBe("check_email");
    expect(stateOf(new URLSearchParams("confirmed=yes"))).toBe("check_email");
  });

  test("the legal pages carry the versions sign-up records", () => {
    expect(readFileSync(join(import.meta.dir, "../pages/legal/dpa.html"), "utf8")).toContain(`Version ${DPA_VERSION}.`);
    expect(readFileSync(join(import.meta.dir, "../pages/legal/terms.html"), "utf8")).toContain(`Version ${TERMS_VERSION}.`);
  });

  // #741. The landing page's forbidden-word rule (FORBIDDEN, checkLanding) does not apply to legal pages.
  test("the privacy notice has one h1 and its nine sections in order; both footers link Privacy and the DPA apart", () => {
    const html = readFileSync(join(import.meta.dir, "../pages/legal/privacy.html"), "utf8");
    checkPrivacy(html);
    // The operator as its trade licence names it (#741): legal name, issuing authority and number, address; no placeholder left.
    for (const fact of ["Renoxium (FZC)", "Sharjah Research Technology and Innovation Park Free Zone (SRTIP)", "licence no. 20400", "Block C-C01-220"]) expect(html).toContain(fact);
    expect(html).not.toMatch(/\[(legal name|issuing authority|address)/u);
    for (const name of ["home", "main"]) {
      const layout = readFileSync(join(import.meta.dir, `../pages/_layouts/${name}.html`), "utf8");
      const footer = layout.slice(layout.indexOf("<footer"), layout.indexOf("</footer>"));
      expect(footer, name).toContain('<a href="/legal/privacy">Privacy</a>');
      expect(footer, name).toMatch(/<a href="\/legal\/dpa">(DPA|Data processing agreement)<\/a>/u);
      expect(footer.match(/href="\/legal\/dpa">Privacy</gu), name).toBeNull();
    }
  });
});

/** The nine sections of the privacy notice, in order (#741). */
const PRIVACY_SECTIONS = ["1. Who we are and how to reach us", "2. What this notice covers", "3. What we collect and why", "4. What an AI assistant connected through the connector receives", "5. Where data is stored and who processes it", "6. How long we keep it", "7. Your rights", "8. Cookies", "9. Changes to this notice"];

function checkPrivacy(html: string): void {
  expect(html.match(/<h1[\s>]/gu)?.length).toBe(1);
  expect([...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/gu)].map((m) => m[1])).toEqual(PRIVACY_SECTIONS);
  expect(html).toContain("support@renoxium.com");
  expect(html).toContain('href="/legal/dpa"');
  for (const row of ["Account", "Waitlist", "Usage and logs", "Billing", "Connector"]) expect(html).toContain(`<th scope="row">${row}</th>`);
}

describe("design system (packages/ui/README.md)", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

  test("public/renox-ui.css is packages/ui/renox-ui.css, unchanged, and loads before site.css", () => {
    expect(read("public/renox-ui.css")).toBe(readFileSync(join(ROOT, "packages/ui/renox-ui.css"), "utf8"));
    for (const name of ["main", "home"]) {
      const layout = read(`pages/_layouts/${name}.html`);
      expect(layout.indexOf('href="/renox-ui.css"'), name).toBeGreaterThan(-1);
      expect(layout.indexOf('href="/site.css"'), name).toBeGreaterThan(layout.indexOf('href="/renox-ui.css"'));
    }
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
  expect(built.manifest.routes.map((r) => ("path" in r ? r.path : "")).sort()).toEqual(["/", "/docs", "/docs/:slug", "/legal/dpa", "/legal/privacy", "/legal/terms", "/pricing", "/thanks"]);
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
    checkLanding(home.text);
    // #740: renox.toml widens form-action to the API, so a browser lets the waitlist form post there.
    const homeHeaders = (await fetch(`${base}/`)).headers;
    expect(homeHeaders.get("content-security-policy")).toContain(`form-action 'self' ${API_ORIGIN}`);
    const ask = home.text.slice(home.text.indexOf('<section id="ask"'));
    expect(ask).toContain(`<form class="waitlist" method="post" action="${API_ORIGIN}/v1/waitlist">`);
    expect(ask).toContain("Join the connector list");
    expect(ask).not.toContain("mailto:support@renoxium.com?subject=Connector");
    // #691: the three states of /thanks, no script of the site's own.
    for (const [query, heading] of [["?confirmed=1&list=connector", "You are on the list."], ["?confirmed=0", "This link no longer works."], ["?list=connector", "Check your mail."]] as const) {
      const t = await get(`/thanks${query}`);
      expect(t.status).toBe(200);
      expect(t.text).toContain(`<h1 id="thanks-title">${heading}</h1>`);
      expect(t.text.match(/<script(?![^>]*src="\/__renox\/)[^>]*>/gu) ?? []).toEqual([]);
    }
    const pricing = await get("/pricing");
    expect(pricing.text).toContain("AED 82.95 with VAT");
    expect((await get("/legal/dpa")).text).toContain(`Version ${DPA_VERSION}.`);
    // #741: the privacy notice is served; the site sets only the platform's two cookies, as the notice says (section 8).
    const privacy = await fetch(`${base}/legal/privacy`);
    expect(privacy.status).toBe(200);
    const privacyHtml = (await privacy.text()).replaceAll(' dir="auto"', "");
    checkPrivacy(privacyHtml);
    expect(privacyHtml).toContain('<a href="/legal/privacy">Privacy</a>');
    for (const path of ["/", "/legal/privacy", "/pricing", "/docs/data"]) {
      const names = (await fetch(`${base}${path}`)).headers.getSetCookie().map((c) => c.slice(0, c.indexOf("=")));
      expect(names.filter((n) => n !== "__Host-renox_sid" && n !== "__Host-renox_csrf"), path).toEqual([]);
      for (const c of (await fetch(`${base}${path}`)).headers.getSetCookie()) expect(c, path).not.toMatch(/max-age|expires/iu);
    }
  } finally {
    await dev.stop();
  }
});

/** The words a business owner should not meet outside the developer section and the footer (#675, copy deck). */
const FORBIDDEN = ["isolate", "V8", "SQLite", "CNAME", "DNS", "Apache", "MCP", "CLI", "repository", "deploy", "htmx", "TypeScript", "SQL", "API", "Docker", "build step"];

/** The text a reader sees: no tags, no comments, no script or style, the entities decoded. */
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&").replace(/&#39;|&#x27;/gu, "'").replace(/&quot;/gu, '"')
    .replace(/\s+/gu, " ");
}

/** The served landing page (#675): the deck's sections in order, the fragments, the plain-language rule. */
function checkLanding(html: string): void {
  // One h1, the deck's headings in order (sections 1 to 10, with 5A to 5D).
  expect(html.match(/<h1[\s>]/gu)?.length).toBe(1);
  expect(html).toContain('<h1 id="hero-title">Own your business software the way you own your shop.</h1>');
  const headings = [...html.matchAll(/<h2 [^>]*>([^<]+)<\/h2>/gu)].map((m) => m[1]);
  expect(headings).toEqual([
    "The why, in one statement",
    "Four things you can ask for.",
    "What you would do instead, and when you should.",
    "Finished on day one.",
    "Yours. Not a promise, a fact you can test.",
    "What your AI is not allowed to touch.",
    "Built for a business in the UAE.",
    "Measured, not promised.",
    "For the people who build apps for others.",
    "When not to use Renoxium, and what to pick instead.",
    "One company, one plan, a tax invoice every month.",
    "Start with a conversation.",
  ]);
  const text = visibleText(html);
  for (const s of ["There is a third.", "The app is yours.", "Four things you can ask for", "coming soon, join the list", "When not to use Renoxium", "A conversation with the planned connector, using our real finished app.", "If a row is unfair, tell us.", "Health records: we do not host them.", "we do not promise that data stays in the UAE"]) expect(text, s).toContain(s);
  for (const a of ASKS) expect(text, a.status).toContain(a.status);
  // The interface fragments: at least six, real HTML, with the conversation's sample data.
  const fragments = [...html.matchAll(/<[a-z]+ [^>]*data-ui="([a-z-]+)"/gu)].map((m) => m[1]);
  expect(fragments.length).toBeGreaterThanOrEqual(6);
  expect(fragments).toEqual(["conversation", "quotation", "day-board", "visit", "invoice", "your-data", "finished-parts"]);
  const chat = html.slice(html.indexOf('data-ui="conversation"'), html.indexOf("</ol>", html.indexOf('data-ui="conversation"')));
  expect(chat).toContain("coolair.renoxium.app");
  expect(chat).toContain("90-day parts warranty");
  expect(chat.match(/<li /gu)?.length).toBe(6);
  expect(chat).not.toContain("<img");
  expect(html).toMatch(/data-ui="invoice" dir="rtl" lang="ar"/u);
  // The alternatives table: four rows.
  const table = html.slice(html.indexOf('<table class="alt-table">'), html.indexOf("</table>", html.indexOf('<table class="alt-table">')));
  expect(table.split("<tbody>")[1]?.match(/<tr>/gu)?.length).toBe(4);
  // The plans: pricing.toml's prices, Starter the one recommended.
  for (const p of PRICING.plans) expect(html).toContain(`AED ${p.price_month.replace(/\.00$/u, "")}</p>`);
  expect([...html.matchAll(/data-plan="([a-z]+)" class="recommended"/gu)].map((m) => m[1])).toEqual(["starter"]);
  expect(html).toContain("Starter, recommended");
  // Honesty: the take-away links #668; the sentence waiting for it is not printed; the figures link to how they were measured.
  expect(html).toContain('href="https://github.com/arif-rachim/renox.rs/issues/668">#668</a>');
  expect(text).not.toContain("if we disappear tomorrow");
  expect(html.match(/href="https:\/\/github\.com\/arif-rachim\/renox\.rs\/blob\/main\/docs\/14-benchmarks\.md">How we measured it</gu)?.length).toBe(2);
  // Links: sign in to the dashboard; the list as the waitlist form (#740); WhatsApp from lib/contact.ts.
  expect(html).toContain('<a class="button" href="https://dashboard.renoxium.com/signin">Sign in</a>');
  expect(WAITLIST_FORM).toBe(true);
  expect(html).toContain(`<form class="waitlist" method="post" action="${LINKS.waitlist}">`);
  expect(html).not.toContain(`href="${LINKS.connectorList.replaceAll("&", "&amp;")}">Join the connector list</a>`);
  expect(html.split(`href="${LINKS.whatsapp}"`).length - 1).toBe(2);
  // Nothing of the previous page remains.
  for (const old of ["Deploy. Run.", "installed, not rewritten", "TLS at the edge", "Built for coding agents", "Stop rebuilding", "dot-idle"]) expect(html, old).not.toContain(old);
  // The plain-language rule: outside section 7 and the footer, no technical word.
  const start = html.indexOf('<section id="developers"');
  const end = html.indexOf("</section>", start);
  const footer = html.indexOf('<footer class="home-footer">');
  expect(start).toBeGreaterThan(-1);
  const plain = visibleText(html.slice(0, start) + html.slice(end, footer));
  const found = FORBIDDEN.filter((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(" ", "\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(plain));
  expect(found).toEqual([]);
  // ...and the developer section is where they are.
  expect(visibleText(html.slice(start, end))).toContain("V8 isolate");
  // No script of the site's own (renox dev injects its own, under /__renox/), no dot face.
  expect(html.match(/<script[^>]*src="([^"]+)"/gu)?.every((m) => m.includes("/__renox/"))).toBe(true);
  expect(html.match(/<script(?![^>]*src="\/__renox\/)[^>]*>/gu) ?? []).toEqual([]);
  expect(html).not.toContain('class="dot');
}
