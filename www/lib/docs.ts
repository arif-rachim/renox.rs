// The developer documentation of the site (#326, #428): an explicit allowlist
// of the files under docs/ and the READMEs the site renders, bundled as text
// at build time, with the navigation grouped as Get started, Guides,
// Reference and Concepts. Anything not listed here is not published: the
// business rationale, roadmap, risks, strategy, build and development plans,
// the execution log, the threat model, the failure modes, the benchmarks and
// the ADRs stay in the repository. `tests/pages.test.ts` checks that an
// unlisted file answers 404 and that nothing outside this list is imported.
//
// Add a page: one import line, one entry of PUBLISHED.

import gettingStarted from "../../docs/getting-started.md" with { type: "text" };
import tutorial from "../../docs/tutorial/README.md" with { type: "text" };
import tutorial01 from "../../docs/tutorial/01-install.md" with { type: "text" };
import tutorial02 from "../../docs/tutorial/02-dev-loop.md" with { type: "text" };
import tutorial03 from "../../docs/tutorial/03-pages.md" with { type: "text" };
import tutorial04 from "../../docs/tutorial/04-data.md" with { type: "text" };
import tutorial05 from "../../docs/tutorial/05-actions.md" with { type: "text" };
import tutorial06 from "../../docs/tutorial/06-teams.md" with { type: "text" };
import tutorial07 from "../../docs/tutorial/07-authorization.md" with { type: "text" };
import tutorial08 from "../../docs/tutorial/08-realtime.md" with { type: "text" };
import tutorial09 from "../../docs/tutorial/09-tests.md" with { type: "text" };
import tutorial10 from "../../docs/tutorial/10-deploy.md" with { type: "text" };
import overview from "../../docs/00-overview.md" with { type: "text" };
import lifecycle from "../../docs/05-tenant-lifecycle.md" with { type: "text" };
import data from "../../docs/06-data.md" with { type: "text" };
import appModel from "../../docs/07-app-model.md" with { type: "text" };
import templates from "../../docs/08-template-engine.md" with { type: "text" };
import realtime from "../../docs/09-htmx-realtime.md" with { type: "text" };
import modules from "../../docs/10-modules.md" with { type: "text" };
import authorization from "../../docs/11-authorization.md" with { type: "text" };
import developerExperience from "../../docs/12-developer-experience.md" with { type: "text" };
import glossary from "../../docs/17-glossary.md" with { type: "text" };
import agents from "../../docs/20-ai-agents-mcp.md" with { type: "text" };
import referenceApp from "../../docs/reference-app.md" with { type: "text" };
import cli from "../../cli/README.md" with { type: "text" };
import sdk from "../../sdk/README.md" with { type: "text" };
// A declaration file imported as text: the bundler reads it as text, tsc sees a .d.ts.
// @ts-expect-error TS2846: imported for its text, not its types.
import ctxTypesRaw from "../../docs/contracts/ctx.d.ts" with { type: "text" };
import errors from "../../docs/contracts/errors.md" with { type: "text" };
import manifest from "../../docs/contracts/manifest.md" with { type: "text" };
import ops from "../../docs/contracts/ops.md" with { type: "text" };

import { render, type Rendered } from "./markdown.ts";

export type Group = "Get started" | "Guides" | "Reference" | "Concepts";

export interface Page {
  /** The repository path, shown nowhere on the page; the "Source on GitHub" link. */
  path: string;
  /** The page's slug under /docs/. */
  slug: string;
  /** The navigation group. */
  group: Group;
  /** The title in the navigation; the page's own title is its first heading. */
  label: string;
  /** The markdown of the page. */
  markdown: string;
}

/** `ops.md` section 10, "Limits per tier and behaviour on limit", as a page of its own. */
function limitsOf(contract: string): string {
  const start = contract.indexOf("## 10. Limits per tier");
  const end = contract.indexOf("\n## ", start + 1);
  const body = contract.slice(start, end === -1 ? undefined : end).replace(/^## 10\.\s*/u, "# ");
  return `${body.trimEnd()}\n\nThese are the defaults the platform enforces; an app may lower a limit in its manifest and never raise it. The full contract of every op, including what each limit does to a request, is [\`ops.md\`](ops.md) in the repository.\n`;
}

/** `ctx.d.ts` as a reference page: one code block. */
const ctxTypes = ctxTypesRaw as unknown as string;
const ctxPage = `# The \`ctx\` surface\n\nThe TypeScript declarations of everything tenant code gets on \`ctx\` (\`docs/contracts/ctx.d.ts\`, the contract the \`renox\` package implements). Section numbers in the comments refer to the ops contract.\n\n\`\`\`\`ts\n${ctxTypes.trimEnd()}\n\`\`\`\`\n`;

/** The published pages, in navigation order (previous and next follow it). */
export const PUBLISHED: readonly Page[] = [
  { path: "docs/getting-started.md", slug: "getting-started", group: "Get started", label: "Getting started", markdown: gettingStarted },
  // The tutorial (#430): an index and ten chapters, in reading order.
  { path: "docs/tutorial/README.md", slug: "tutorial", group: "Get started", label: "Tutorial: a team board", markdown: tutorial },
  { path: "docs/tutorial/01-install.md", slug: "tutorial-install", group: "Get started", label: "1. Install and create", markdown: tutorial01 },
  { path: "docs/tutorial/02-dev-loop.md", slug: "tutorial-dev-loop", group: "Get started", label: "2. The dev loop", markdown: tutorial02 },
  { path: "docs/tutorial/03-pages.md", slug: "tutorial-pages", group: "Get started", label: "3. Pages and templates", markdown: tutorial03 },
  { path: "docs/tutorial/04-data.md", slug: "tutorial-data", group: "Get started", label: "4. Data", markdown: tutorial04 },
  { path: "docs/tutorial/05-actions.md", slug: "tutorial-actions", group: "Get started", label: "5. Functions and forms", markdown: tutorial05 },
  { path: "docs/tutorial/06-teams.md", slug: "tutorial-teams", group: "Get started", label: "6. Sign-in and teams", markdown: tutorial06 },
  { path: "docs/tutorial/07-authorization.md", slug: "tutorial-authorization", group: "Get started", label: "7. Authorization", markdown: tutorial07 },
  { path: "docs/tutorial/08-realtime.md", slug: "tutorial-realtime", group: "Get started", label: "8. Realtime", markdown: tutorial08 },
  { path: "docs/tutorial/09-tests.md", slug: "tutorial-tests", group: "Get started", label: "9. Tests", markdown: tutorial09 },
  { path: "docs/tutorial/10-deploy.md", slug: "tutorial-deploy", group: "Get started", label: "10. Deploy and a domain", markdown: tutorial10 },
  { path: "docs/12-developer-experience.md", slug: "developer-experience", group: "Get started", label: "Developer experience", markdown: developerExperience },
  { path: "docs/07-app-model.md", slug: "app-model", group: "Guides", label: "App model", markdown: appModel },
  { path: "docs/06-data.md", slug: "data", group: "Guides", label: "Data", markdown: data },
  { path: "docs/08-template-engine.md", slug: "templates", group: "Guides", label: "Templates", markdown: templates },
  { path: "docs/09-htmx-realtime.md", slug: "realtime", group: "Guides", label: "Fragments and realtime", markdown: realtime },
  { path: "docs/10-modules.md", slug: "modules", group: "Guides", label: "Modules", markdown: modules },
  { path: "docs/11-authorization.md", slug: "authorization", group: "Guides", label: "Authorization", markdown: authorization },
  { path: "docs/20-ai-agents-mcp.md", slug: "ai-agents-mcp", group: "Guides", label: "AI agents and MCP", markdown: agents },
  { path: "docs/reference-app.md", slug: "reference-app", group: "Guides", label: "Reference app", markdown: referenceApp },
  { path: "cli/README.md", slug: "cli", group: "Reference", label: "CLI", markdown: cli },
  { path: "sdk/README.md", slug: "sdk", group: "Reference", label: "SDK", markdown: sdk },
  { path: "docs/contracts/ctx.d.ts", slug: "ctx", group: "Reference", label: "ctx types", markdown: ctxPage },
  { path: "docs/contracts/errors.md", slug: "errors", group: "Reference", label: "Errors", markdown: errors },
  { path: "docs/contracts/manifest.md", slug: "manifest", group: "Reference", label: "Module manifest", markdown: manifest },
  { path: "docs/contracts/ops.md", slug: "limits", group: "Reference", label: "Limits", markdown: limitsOf(ops) },
  { path: "docs/00-overview.md", slug: "overview", group: "Concepts", label: "Overview", markdown: overview },
  { path: "docs/05-tenant-lifecycle.md", slug: "tenant-lifecycle", group: "Concepts", label: "Tenant lifecycle", markdown: lifecycle },
  { path: "docs/17-glossary.md", slug: "glossary", group: "Concepts", label: "Glossary", markdown: glossary },
];

export const GROUPS: readonly Group[] = ["Get started", "Guides", "Reference", "Concepts"];

/** Extra navigation links into a page's section: the guides a developer looks for by name. */
export const SECTION_LINKS: readonly { group: Group; label: string; slug: string; anchor: string; after: string }[] = [
  { group: "Get started", label: "Install", slug: "getting-started", anchor: "install", after: "getting-started" },
  { group: "Get started", label: "Your first app", slug: "getting-started", anchor: "your-first-app", after: "getting-started" },
  { group: "Get started", label: "Deploy", slug: "getting-started", anchor: "deploy", after: "getting-started" },
  { group: "Guides", label: "Custom domains", slug: "tenant-lifecycle", anchor: "custom-domains-and-dns", after: "authorization" },
];

export const REPO = "https://github.com/arif-rachim/renox.rs/blob/main/";
/** GitHub answers 400 for a directory under /blob/; a directory is under /tree/ (#449). */
export const REPO_TREE = "https://github.com/arif-rachim/renox.rs/tree/main/";

/** The repository URL of a path: /tree/ for a directory (a trailing slash, or a last segment without an extension), /blob/ for a file. */
export function repoUrl(path: string): string {
  const last = path.replace(/\/+$/u, "").split("/").pop() ?? "";
  return `${path === "" || path.endsWith("/") || !/\.[A-Za-z0-9]+$/u.test(last) ? REPO_TREE : REPO}${path}`;
}

/** Repository path -> markdown text, for the link resolver and the tests. */
export const SOURCES: ReadonlyMap<string, string> = new Map(PUBLISHED.filter((p) => p.slug !== "limits" && p.slug !== "ctx").map((p) => [p.path, p.markdown]));

const bySlug = new Map(PUBLISHED.map((p) => [p.slug, p]));
const byPath = new Map(PUBLISHED.filter((p) => p.slug !== "limits").map((p) => [p.path, p]));

/** The slug of a published repository path, or null. */
export const slugOfPath = (path: string): string | null => byPath.get(path)?.slug ?? null;

/** "07 — Tenant application model" -> "Tenant application model"; inline code marks and issue numbers dropped. */
export const cleanTitle = (title: string): string =>
  title
    .replace(/`/gu, "")
    .replace(/^\d+\s+—\s+/u, "")
    .replace(/\s*\(#\d+\)\s*$/u, "")
    .trim();

/** A link target of the document at `from`, as an href of the site. */
export function resolver(from: string): (target: string) => string {
  return (target) => {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("#")) return target;
    const [path, anchor] = target.split("#", 2) as [string, string | undefined];
    const base = from.split("/").slice(0, -1);
    for (const part of path.split("/")) {
      if (part === "..") base.pop();
      else if (part !== "." && part !== "") base.push(part);
    }
    const resolved = path.startsWith("/") ? path.slice(1) : base.join("/");
    const hash = anchor === undefined ? "" : `#${anchor}`;
    const slug = slugOfPath(resolved);
    if (slug !== null) return `/docs/${slug}${hash}`;
    return `${repoUrl(resolved)}${hash}`;
  };
}

export interface NavItem {
  group: Group;
  label: string;
  href: string;
  slug: string;
  current: boolean;
}

export interface Doc extends Rendered {
  path: string;
  slug: string;
  group: Group;
  label: string;
  /** The on-page contents: the `##` headings. */
  contents: { text: string; id: string }[];
  previous: { label: string; href: string } | null;
  next: { label: string; href: string } | null;
}

const rendered = new Map<string, Doc>();

/** The rendered page of `slug`, or null when it is not published. */
export function doc(slug: string): Doc | null {
  const page = bySlug.get(slug);
  if (page === undefined) return null;
  const cached = rendered.get(slug);
  if (cached !== undefined) return cached;
  const r = render(page.markdown, resolver(page.path));
  const i = PUBLISHED.indexOf(page);
  const link = (p: Page | undefined) => (p === undefined ? null : { label: p.label, href: `/docs/${p.slug}` });
  const d: Doc = {
    ...r,
    // The page shows no number: "06 — Data" is "Data" in the heading too.
    html: r.html.replace(/(<h1 id="[^"]+">)\d+\s+—\s+/u, "$1"),
    title: cleanTitle(r.title || page.label),
    path: page.path,
    slug: page.slug,
    group: page.group,
    label: page.label,
    contents: r.headings.filter((h) => h.level === 2).map((h) => ({ text: cleanTitle(h.text), id: h.id })),
    previous: link(PUBLISHED[i - 1]),
    next: link(PUBLISHED[i + 1]),
  };
  rendered.set(slug, d);
  return d;
}

/** The navigation: every page in order, with the section links after their page, grouped; `current` marks `slug`. */
export function nav(slug: string | null): { group: Group; items: NavItem[] }[] {
  const items: NavItem[] = [];
  for (const p of PUBLISHED) {
    items.push({ group: p.group, label: p.label, href: `/docs/${p.slug}`, slug: p.slug, current: p.slug === slug });
    for (const s of SECTION_LINKS.filter((s) => s.after === p.slug)) items.push({ group: s.group, label: s.label, href: `/docs/${s.slug}#${s.anchor}`, slug: s.slug, current: false });
  }
  return GROUPS.map((group) => ({ group, items: items.filter((i) => i.group === group) }));
}

export interface Hit {
  slug: string;
  title: string;
  group: Group;
  /** The matching section, or null when the title matched. */
  section: { text: string; href: string } | null;
}

/** Pages whose title, and sections whose heading, contain every word of `q` (case-insensitive). */
export function search(q: string): Hit[] {
  const words = q.toLowerCase().split(/\s+/u).filter((w) => w !== "");
  if (words.length === 0) return [];
  const matches = (s: string) => words.every((w) => s.toLowerCase().includes(w));
  const hits: Hit[] = [];
  for (const p of PUBLISHED) {
    const d = doc(p.slug) as Doc;
    if (matches(d.title) || matches(p.label)) hits.push({ slug: p.slug, title: d.title, group: p.group, section: null });
    for (const h of d.headings.filter((h) => h.level > 1)) {
      if (matches(h.text)) hits.push({ slug: p.slug, title: d.title, group: p.group, section: { text: cleanTitle(h.text), href: `/docs/${p.slug}#${h.id}` } });
    }
  }
  return hits.slice(0, 50);
}
