// llms.txt for Renoxium (#377, #428): the index of the developer documentation for
// language models, in the llms.txt convention (https://llmstxt.org): a title,
// a one-paragraph summary, then sections of "- [title](url): description"
// lines. `llms-full.txt` is the developer-facing documents concatenated,
// for agents that want the text in one request. Both are generated from the
// repository and committed under www/public/, which the site serves as
// /llms.txt and /llms-full.txt (an app's public/ is served at its root,
// docs/07-app-model.md). Both follow the site's allowlist (www/lib/docs.ts):
// a page of the site is linked as a page; a file the site does not render
// (READMEs, the cross-track contracts) is linked in the repository; the
// internal planning documents (business, roadmap, risks, build plan, GCC
// strategy, development plan, failure modes, threat model, execution, the
// ADRs, the benchmarks, the deploy API) appear nowhere.
//
//   bun run llms          (in www/; or bun www/scripts/llms.ts from the root)
//
// tests/llms.test.ts regenerates and compares, so the committed files cannot
// drift from the sources. The output has no date or hash, on purpose.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanTitle, repoUrl, slugOfPath } from "../lib/docs.ts";

export const ROOT = resolve(import.meta.dir, "../..");
/** The site: published documents are pages under /docs/<slug> (lib/docs.ts). */
export const SITE = "https://renoxium.com";
/** Files the site does not render link to the repository. */
export const REPO = "https://github.com/arif-rachim/renox.rs/blob/main/";

/** The site's page of a published path, or its file in the repository. */
const site = (path: string): string => {
  const slug = slugOfPath(path);
  return slug === null ? repoUrl(path) : `${SITE}/docs/${slug}`;
};
/** A directory is under /tree/, a file under /blob/ (#449: /blob/main/examples/ answers 400). */
const repo = (path: string): string => repoUrl(path);

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
/** The document's first heading, without inline code marks, numbers and issue numbers. */
const title = (path: string): string =>
  cleanTitle(/^#\s+(.+)$/mu.exec(read(path))?.[1] ?? path)
    // Square brackets would end the link text early (the manifest contract's title has `[modules]`).
    .replace(/[[\]]/gu, "");

/** The developer-facing documents, in reading order, with the line llms.txt shows for each. */
export const DEV_DOCS: readonly [path: string, line: string][] = [
  ["docs/getting-started.md", "install the CLI with one line (or run it from the repository), renox new, renox dev, renox login, renox deploy, what to read next"],
  ["docs/07-app-model.md", "folders are routes: functions/, pages/ with loaders and actions, migrations/, policies/, jobs/, public/; renox.toml; the ctx SDK"],
  ["docs/08-template-engine.md", "HTML-first templates with r-* attributes compiled to minijinja, layouts, partials as <x-name>, fragments, render fuel"],
  ["docs/09-htmx-realtime.md", "htmx fragments, morphing and view transitions; SSE and WebSocket routes with topics and authorization"],
  ["docs/10-modules.md", "the module system: manifest, permissions, services, events, hooks, slots, overrides, tables prefixed <module>__"],
  ["docs/11-authorization.md", "Cedar policies, guard exports, r-can in templates, db.scoped(), roles and 2FA step-up"],
  ["docs/12-developer-experience.md", "installing the CLI and the SDK, renox new/dev/check/test/deploy, building with an AI agent, debugging, limits"],
  ["docs/20-ai-agents-mcp.md", "renox mcp (local) and mcp.renoxium.com (remote) for coding agents, App MCP tools per app, ctx.ai, agent security rules"],
];

/** The reference pages and contracts: what tenant code and tools can rely on. */
export const CONTRACTS: readonly [path: string, line: string][] = [
  ["docs/contracts/ctx.d.ts", "the TypeScript declarations of everything tenant code gets on ctx"],
  ["docs/contracts/errors.md", "error codes, HTTP statuses and response bodies"],
  ["docs/contracts/manifest.md", "what a module declares in module.toml and what the tenant approves"],
  [`${SITE}/docs/limits`, "the limits per tier (CPU, wall clock, heap, concurrency, egress) and what happens at each"],
  ["docs/contracts/ops.md", "every op tenant code can call (db, fetch, secrets, log, storage, ai, pdf, realtime, jobs) and the error codes; the full contract, in the repository"],
  ["docs/contracts/artifact.md", "what renox build produces and renox deploy uploads: manifest, routes, code, templates, migrations, public files"],
  ["docs/contracts/meter.md", "the per-request meter record that usage and billing are computed from"],
  ["docs/contracts/client-events.md", "the browser events the renox client script reports"],
];

/** Background documents an agent may want after the developer ones. */
const OPTIONAL: readonly [path: string, line: string][] = [
  ["docs/00-overview.md", "what Renoxium is, the principles, the expectations"],
  ["docs/05-tenant-lifecycle.md", "deploy pipeline, routing and cold start, custom domains, secrets, metering, lifecycle states"],
  ["docs/06-data.md", "one SQLite file per tenant, the authorizer, migrations, replication"],
  ["docs/17-glossary.md", "the terms"],
];

export interface Module {
  name: string;
  dir: string;
  description: string;
}

/** The official modules under modules/, with the description of each module.toml. */
export function modules(): Module[] {
  return readdirSync(join(ROOT, "modules"))
    .filter((d) => existsSync(join(ROOT, "modules", d, "module.toml")))
    .sort()
    .map((dir) => {
      const toml = read(`modules/${dir}/module.toml`);
      const name = /^name\s*=\s*"([^"]+)"/mu.exec(toml)?.[1] ?? dir;
      const description = /^description\s*=\s*"([^"]+)"/mu.exec(toml)?.[1] ?? "";
      return { name, dir, description };
    });
}

const SUMMARY =
  "Renoxium is a multi-tenant hosting platform for web applications and functions written in TypeScript. " +
  "An app is TypeScript functions and HTML pages in folders that are its routes; it runs in a V8 isolate with its own SQLite file, " +
  "under CPU, memory, wall-clock and network limits enforced by the platform, and it assembles auth, organisations, billing, " +
  "admin, storage, email and other official modules instead of writing them. The toolkit a developer types is `renox`: the CLI " +
  "(`renox new`, `dev`, `check`, `test`, `deploy`) and the npm package `@renoxium/sdk` (types, helpers, test fakes).";

const AGENT_NOTE =
  "For coding agents: `renox new` writes an `AGENTS.md`, a `CLAUDE.md` and a `.mcp.json` into every new app; `renox mcp` is the " +
  "local MCP server (project status, check and test results, policy explanations, these documents as resources); " +
  "`mcp.renoxium.com` is the remote one behind OAuth 2.1. The full text of the documents below is at " +
  `${SITE}/llms-full.txt. Links to github.com are files the site does not render.`;

/** The index. */
export function llmsTxt(): string {
  const lines: string[] = ["# Renoxium", "", `> ${SUMMARY}`, "", AGENT_NOTE, ""];
  const section = (name: string, items: readonly [string, string][]): void => {
    lines.push(`## ${name}`, "");
    for (const [url, line] of items) lines.push(`- ${url}: ${line}`);
    lines.push("");
  };
  const doc = (path: string): string => `[${title(path)}](${site(path)})`;
  section("Getting started", [
    [doc("docs/getting-started.md"), "install the CLI with one line, create an app with renox new, run it with renox dev, sign in, deploy it"],
    [doc("docs/12-developer-experience.md"), "the CLI and SDK releases, building with an AI agent, the dev loop, types, debugging, limits"],
    [`[renox CLI reference](${site("cli/README.md")})`, "every command, exit codes, renox build, renox check, renox test, renox mcp, renox deploy"],
    [`[The SDK, @renoxium/sdk](${site("sdk/README.md")})`, "the `@renoxium/sdk` npm package: Handler, Ctx, pages, validate, modules, query builders, @renoxium/sdk/fakes and @renoxium/sdk/test"],
    [`[Example apps](${repo("examples/")})`, "hello (one function), shop (pages, templates, modules, policies), chat (realtime)"],
  ]);
  section("App model", DEV_DOCS.filter(([p]) => !/getting-started|12-developer-experience|20-ai-agents-mcp/u.test(p)).map(([p, line]) => [doc(p), line]));
  section("Modules", [
    [doc("docs/10-modules.md"), "how modules are installed (renox add), configured and talk to each other"],
    ...modules().map((m): [string, string] => [`[${m.name}](${repo(`modules/${m.dir}/README.md`)})`, m.description]),
  ]);
  section("CLI", [
    [`[renox CLI reference](${site("cli/README.md")})`, "renox new, dev, build, check, test, add, remove, migrate, deploy, logs, secrets, db, jobs, authz explain, mcp"],
    [`[Installing the CLI and the SDK](${site("docs/12-developer-experience.md")}#installing-the-cli)`, "the one-line install of the signed CLI binaries, the SDK @renoxium/sdk on npm at the same version, WSL 2, verifying, upgrading"],
  ]);
  section("MCP for agents", [
    [doc("docs/20-ai-agents-mcp.md"), "the platform MCP (local and remote), App MCP tools, in-app agents with ctx.ai, agent security"],
    [`[Build with an AI agent](${site("docs/12-developer-experience.md")}#build-with-an-ai-agent)`, "connect Claude Code, Cursor or Codex to renox mcp; the remote MCP and its scopes; what agents may and may not do"],
    [`[renox mcp](${site("cli/README.md")}#renox-mcp)`, "the local server: tools dev_status, dev_errors, run_check, run_tests, search_docs, authz_explain, list_policies, list_tools; resources docs://, config://effective, routes://"],
    [`[Remote platform MCP](${repo("control/api/src/mcp/README.md")})`, "mcp.renoxium.com: OAuth 2.1 with PKCE, scopes apps:read, apps:write, deploy, logs:read, secrets:read; confirmation tokens for mutating tools"],
  ]);
  section("Reference", CONTRACTS.map(([p, line]) => [p.startsWith("https://") ? `[Limits](${p})` : doc(p), line]));
  section("Optional", OPTIONAL.map(([p, line]) => [doc(p), line]));
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The files llms-full.txt concatenates, in order. */
export function fullSources(): string[] {
  return [...DEV_DOCS.map(([p]) => p), "cli/README.md", "sdk/README.md", "docs/contracts/errors.md", "docs/contracts/manifest.md", ...modules().map((m) => `modules/${m.dir}/README.md`)];
}

/** The developer-facing documents in one file. */
export function llmsFullTxt(): string {
  const parts = [
    "# Renoxium: the developer documentation in one file",
    "",
    `> ${SUMMARY}`,
    "",
    `The documents below are the developer-facing ones of ${REPO}, in reading order, each introduced by a "Source:" line with its path and URL. ` +
      "Relative links inside a document are repository paths. The index is " +
      `${SITE}/llms.txt; the rendered pages are under ${SITE}/docs/.`,
  ];
  for (const path of fullSources()) {
    parts.push("", "---", "", `Source: ${path} (${repo(path)})`, "", read(path).trimEnd());
  }
  return `${parts.join("\n")}\n`;
}

export const OUT = {
  llms: join(ROOT, "www", "public", "llms.txt"),
  full: join(ROOT, "www", "public", "llms-full.txt"),
};

if (import.meta.main) {
  writeFileSync(OUT.llms, llmsTxt());
  writeFileSync(OUT.full, llmsFullTxt());
  console.log(`wrote ${OUT.llms} and ${OUT.full}`);
}
