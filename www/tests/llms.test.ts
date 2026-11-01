// llms.txt and llms-full.txt (#377): the committed files equal a fresh
// generation (so they cannot drift from the documents), the index follows
// the llms.txt convention, every link lands on a page of the site or a file
// of the repository, and every official module is listed. The site serves
// www/public/ at its root, so the files are /llms.txt and /llms-full.txt.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sidebar } from "../lib/docs.ts";
import { fullSources, llmsFullTxt, llmsTxt, modules, OUT, REPO, ROOT, SITE } from "../scripts/llms.ts";

describe("llms.txt", () => {
  const index = llmsTxt();
  const full = llmsFullTxt();

  test("the committed files are up to date (bun run llms regenerates them)", () => {
    expect(readFileSync(OUT.llms, "utf8")).toBe(index);
    expect(readFileSync(OUT.full, "utf8")).toBe(full);
  });

  test("the index has the llms.txt shape: title, summary, sections of linked lines", () => {
    const lines = index.split("\n");
    expect(lines[0]).toBe("# Renoxium");
    expect(lines[2]?.startsWith("> ")).toBe(true);
    const sections = lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
    expect(sections).toEqual(["Getting started", "App model", "Modules", "CLI", "MCP for agents", "Contracts", "Optional"]);
    for (const l of lines.filter((l) => l.startsWith("- "))) expect(l).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\): .+$/u);
    // No date, no hash: a regeneration without a document change is a no-op.
    expect(index).not.toMatch(/20\d\d-\d\d-\d\d/u);
  });

  test("every link is a page of the site or a file of the repository", () => {
    const slugs = new Set(sidebar().map((d) => d.slug));
    for (const [, url] of index.matchAll(/\]\((https:\/\/[^)#\s]+)(?:#[^)]*)?\)/gu)) {
      if (url!.startsWith(`${SITE}/docs/`)) expect(slugs.has(url!.slice(`${SITE}/docs/`.length)), url).toBe(true);
      else if (url!.startsWith(REPO)) expect(existsSync(join(ROOT, url!.slice(REPO.length))), url).toBe(true);
      else throw new Error(`unexpected link ${url}`);
    }
    expect(index).toContain(`${SITE}/llms-full.txt`);
  });

  test("every official module is listed with its module.toml description", () => {
    const names = modules().map((m) => m.name);
    expect(names.length).toBeGreaterThanOrEqual(16);
    for (const m of modules()) {
      expect(m.description.length).toBeGreaterThan(0);
      expect(index).toContain(`- [${m.name}](${REPO}modules/${m.dir}/README.md): ${m.description}`);
    }
  });

  test("llms-full.txt holds the developer documents, the CLI and SDK READMEs and the module READMEs, not the planning documents", () => {
    for (const path of fullSources()) {
      expect(full).toContain(`Source: ${path} (${REPO}${path})`);
      expect(full).toContain(readFileSync(join(ROOT, path), "utf8").trimEnd());
    }
    for (const excluded of ["docs/01-business.md", "docs/15-roadmap.md", "docs/16-risks.md", "docs/18-build-plan.md", "docs/21-uae-gcc-strategy.md", "docs/22-development-plan.md", "docs/23-failure-modes.md", "docs/24-threat-model.md", "docs/25-execution.md"]) {
      expect(full).not.toContain(`Source: ${excluded}`);
    }
  });
});
