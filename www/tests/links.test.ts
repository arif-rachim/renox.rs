// Link checker of the site (#449): every link of every published page and of
// llms.txt / llms-full.txt lands somewhere. A site link names a published
// page (and an anchor that page has); a repository link names a file that
// exists under /blob/ or a directory under /tree/ (GitHub answers 400 for a
// directory under /blob/, the bug of llms.txt's examples link). The Limits
// page's relative link once resolved to docs/contracts/contracts/ops.md.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { doc, PUBLISHED, REPO, REPO_TREE, resolver } from "../lib/docs.ts";
import { render } from "../lib/markdown.ts";
import { OUT } from "../scripts/llms.ts";

const ROOT = join(import.meta.dir, "../..");
const SITE = "https://renoxium.com";

/** The anchors a page renders: the ids of its headings. */
function anchorsOf(slug: string): Set<string> {
  const page = PUBLISHED.find((p) => p.slug === slug);
  if (page === undefined) return new Set();
  return new Set(render(page.markdown, resolver(page.path)).headings.map((h) => h.id));
}

/** What is wrong with one href, or null. */
export function brokenLink(href: string): string | null {
  if (href.startsWith("#") || href.startsWith("mailto:")) return null;
  const site = href.startsWith(SITE) ? href.slice(SITE.length) : href.startsWith("/") ? href : null;
  if (site !== null) {
    const [path, anchor] = site.split("#", 2) as [string, string | undefined];
    if (!path.startsWith("/docs/")) return ["/", "/pricing", "/docs", "/llms.txt", "/llms-full.txt", "/legal/dpa", "/legal/privacy", "/legal/terms"].includes(path.replace(/\/$/u, "") || "/") ? null : `${href}: not a page of the site`;
    const slug = path.slice("/docs/".length);
    if (doc(slug) === null) return `${href}: no published page ${slug}`;
    if (anchor !== undefined && !anchorsOf(slug).has(anchor)) return `${href}: /docs/${slug} has no #${anchor}`;
    return null;
  }
  for (const [base, kind] of [[REPO, "file"], [REPO_TREE, "dir"]] as const) {
    if (!href.startsWith(base)) continue;
    const rel = decodeURIComponent(href.slice(base.length).split("#")[0] as string);
    const p = join(ROOT, rel);
    if (!existsSync(p)) return `${href}: ${rel} does not exist in the repository`;
    const isDir = statSync(p).isDirectory();
    if (kind === "file" && isDir) return `${href}: a directory under /blob/ (GitHub answers 400; use /tree/)`;
    if (kind === "dir" && !isDir) return `${href}: a file under /tree/`;
    return null;
  }
  if (href.startsWith("https://github.com/arif-rachim/renox.rs/")) return `${href}: a repository link that is neither /blob/main/ nor /tree/main/`;
  return null;
}

describe("links of the site", () => {
  test("every link of every published page lands on a page, an anchor, or a repository file or directory", () => {
    const broken: string[] = [];
    for (const page of PUBLISHED) {
      const html = render(page.markdown, resolver(page.path)).html;
      for (const [, href] of html.matchAll(/<a href="([^"]+)"/gu)) {
        const why = brokenLink((href as string).replaceAll("&amp;", "&"));
        if (why !== null) broken.push(`${page.path}: ${why}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("every link of llms.txt and llms-full.txt lands", () => {
    const broken: string[] = [];
    for (const file of [OUT.llms, OUT.full]) {
      for (const [, href] of readFileSync(file, "utf8").matchAll(/\]\((https:\/\/(?:renoxium\.com|github\.com\/arif-rachim\/renox\.rs)[^)\s]*)\)/gu)) {
        const why = brokenLink(href as string);
        if (why !== null) broken.push(`${file.slice(ROOT.length + 1)}: ${why}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("the checker fails on a planted broken link of each kind", () => {
    expect(brokenLink(`${REPO}examples/`)).toContain("a directory under /blob/");
    expect(brokenLink(`${REPO}docs/contracts/contracts/ops.md`)).toContain("does not exist");
    expect(brokenLink("/docs/no-such-page")).toContain("no published page");
    expect(brokenLink("/docs/getting-started#no-such-heading")).toContain("has no #no-such-heading");
    expect(brokenLink(`${REPO_TREE}examples/`)).toBeNull();
    expect(brokenLink(`${REPO}docs/contracts/ops.md`)).toBeNull();
  });

  test("the Limits page links the whole ops contract in the repository", () => {
    const limits = PUBLISHED.find((p) => p.slug === "limits");
    const html = render(limits?.markdown ?? "", resolver("docs/contracts/ops.md")).html;
    expect(html).toContain(`href="${REPO}docs/contracts/ops.md"`);
    expect(html).not.toContain("contracts/contracts");
  });
});
