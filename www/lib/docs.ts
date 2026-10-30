// The documentation of the site (#326): every markdown file under docs/ and
// docs/contracts/, bundled as text at build time, with its page slug, and
// the sidebar in the reading order of AGENTS.md. `tests/pages.test.ts`
// checks that this list is every file of those directories.
//
// Regenerate the imports when a document is added: one line per file.

import agents from "../../AGENTS.md" with { type: "text" };
import d0 from "../../docs/00-overview.md" with { type: "text" };
import d1 from "../../docs/01-business.md" with { type: "text" };
import d2 from "../../docs/02-comparison.md" with { type: "text" };
import d3 from "../../docs/03-architecture.md" with { type: "text" };
import d4 from "../../docs/04-isolation-security.md" with { type: "text" };
import d5 from "../../docs/05-tenant-lifecycle.md" with { type: "text" };
import d6 from "../../docs/06-data.md" with { type: "text" };
import d7 from "../../docs/07-app-model.md" with { type: "text" };
import d8 from "../../docs/08-template-engine.md" with { type: "text" };
import d9 from "../../docs/09-htmx-realtime.md" with { type: "text" };
import d10 from "../../docs/10-modules.md" with { type: "text" };
import d11 from "../../docs/11-authorization.md" with { type: "text" };
import d12 from "../../docs/12-developer-experience.md" with { type: "text" };
import d13 from "../../docs/13-decisions.md" with { type: "text" };
import d14 from "../../docs/14-benchmarks.md" with { type: "text" };
import d15 from "../../docs/15-roadmap.md" with { type: "text" };
import d16 from "../../docs/16-risks.md" with { type: "text" };
import d17 from "../../docs/17-glossary.md" with { type: "text" };
import d18 from "../../docs/18-build-plan.md" with { type: "text" };
import d19 from "../../docs/19-platform-wireframes.md" with { type: "text" };
import d20 from "../../docs/20-ai-agents-mcp.md" with { type: "text" };
import d21 from "../../docs/21-uae-gcc-strategy.md" with { type: "text" };
import d22 from "../../docs/22-development-plan.md" with { type: "text" };
import d23 from "../../docs/23-failure-modes.md" with { type: "text" };
import d24 from "../../docs/24-threat-model.md" with { type: "text" };
import d25 from "../../docs/25-execution.md" with { type: "text" };
import d26 from "../../docs/contracts/README.md" with { type: "text" };
import d27 from "../../docs/contracts/artifact.md" with { type: "text" };
import d28 from "../../docs/contracts/client-events.md" with { type: "text" };
import d29 from "../../docs/contracts/deploy-api.md" with { type: "text" };
import d30 from "../../docs/contracts/errors.md" with { type: "text" };
import d31 from "../../docs/contracts/manifest.md" with { type: "text" };
import d32 from "../../docs/contracts/meter.md" with { type: "text" };
import d33 from "../../docs/contracts/ops.md" with { type: "text" };

import { render, type Rendered } from "./markdown.ts";

/** Repository path -> markdown text. */
export const SOURCES: ReadonlyMap<string, string> = new Map([
  ["docs/00-overview.md", d0],
  ["docs/01-business.md", d1],
  ["docs/02-comparison.md", d2],
  ["docs/03-architecture.md", d3],
  ["docs/04-isolation-security.md", d4],
  ["docs/05-tenant-lifecycle.md", d5],
  ["docs/06-data.md", d6],
  ["docs/07-app-model.md", d7],
  ["docs/08-template-engine.md", d8],
  ["docs/09-htmx-realtime.md", d9],
  ["docs/10-modules.md", d10],
  ["docs/11-authorization.md", d11],
  ["docs/12-developer-experience.md", d12],
  ["docs/13-decisions.md", d13],
  ["docs/14-benchmarks.md", d14],
  ["docs/15-roadmap.md", d15],
  ["docs/16-risks.md", d16],
  ["docs/17-glossary.md", d17],
  ["docs/18-build-plan.md", d18],
  ["docs/19-platform-wireframes.md", d19],
  ["docs/20-ai-agents-mcp.md", d20],
  ["docs/21-uae-gcc-strategy.md", d21],
  ["docs/22-development-plan.md", d22],
  ["docs/23-failure-modes.md", d23],
  ["docs/24-threat-model.md", d24],
  ["docs/25-execution.md", d25],
  ["docs/contracts/README.md", d26],
  ["docs/contracts/artifact.md", d27],
  ["docs/contracts/client-events.md", d28],
  ["docs/contracts/deploy-api.md", d29],
  ["docs/contracts/errors.md", d30],
  ["docs/contracts/manifest.md", d31],
  ["docs/contracts/meter.md", d32],
  ["docs/contracts/ops.md", d33],
]);

export const REPO = "https://github.com/arif-rachim/renox.rs/blob/main/";

/** `docs/00-overview.md` -> `00-overview`; `docs/contracts/ops.md` -> `contracts-ops`. */
export const slugOfPath = (path: string): string => path.replace(/^docs\//u, "").replace(/\.md$/u, "").replace(/\//gu, "-");

export interface Doc {
  path: string;
  slug: string;
  title: string;
}

const pathOfSlug = new Map([...SOURCES.keys()].map((p) => [slugOfPath(p), p]));

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
    if (SOURCES.has(resolved)) return `/docs/${slugOfPath(resolved)}${hash}`;
    return `${REPO}${resolved}${hash}`;
  };
}

/** The rendered document of `slug`, or null. */
export function doc(slug: string): (Rendered & Doc) | null {
  const path = pathOfSlug.get(slug);
  if (path === undefined) return null;
  const r = render(SOURCES.get(path) as string, resolver(path));
  return { ...r, path, slug, title: r.title || slug };
}

const titleOf = (path: string): string => /^#\s+(.+)$/mu.exec(SOURCES.get(path) ?? "")?.[1]?.replace(/`/gu, "") ?? path;

/** The sidebar: AGENTS.md's reading order, then the contracts. */
export function sidebar(): Doc[] {
  const ordered = [...agents.matchAll(/^\d+\.\s+`(docs\/[^`]+\.md)`/gmu)].map((m) => m[1] as string).filter((p) => SOURCES.has(p));
  const rest = [...SOURCES.keys()].filter((p) => !ordered.includes(p)).sort();
  return [...ordered, ...rest].map((path) => ({ path, slug: slugOfPath(path), title: titleOf(path) }));
}

/** Documents whose title contains every word of `q` (case-insensitive). */
export function search(q: string): Doc[] {
  const words = q.toLowerCase().split(/\s+/u).filter((w) => w !== "");
  return sidebar().filter((d) => words.every((w) => d.title.toLowerCase().includes(w)));
}
