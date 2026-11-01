// llms.txt for Renoxium (#377): the index of the developer documentation for
// language models, in the llms.txt convention (https://llmstxt.org): a title,
// a one-paragraph summary, then sections of "- [title](url): description"
// lines. `llms-full.txt` is the developer-facing documents concatenated,
// for agents that want the text in one request. Both are generated from the
// repository and committed under www/public/, which the site serves as
// /llms.txt and /llms-full.txt (an app's public/ is served at its root,
// docs/07-app-model.md). The internal planning documents (business, roadmap,
// risks, build plan, GCC strategy, development plan, failure modes, threat
// model, execution) are not included.
//
//   bun run llms          (in www/; or bun www/scripts/llms.ts from the root)
//
// tests/llms.test.ts regenerates and compares, so the committed files cannot
// drift from the sources. The output has no date or hash, on purpose.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
/** The site: documents are pages under /docs/<slug> (lib/docs.ts). */
export const SITE = "https://renoxium.com";
/** Files the site does not render (READMEs of the CLI, the SDK, the modules) link to the repository. */
export const REPO = "https://github.com/arif-rachim/renox.rs/blob/main/";

/** `docs/07-app-model.md` -> `07-app-model`; `docs/contracts/ops.md` -> `contracts-ops` (lib/docs.ts). */
const slug = (path: string): string => path.replace(/^docs\//u, "").replace(/\.md$/u, "").replace(/\//gu, "-");
const site = (path: string): string => `${SITE}/docs/${slug(path)}`;
const repo = (path: string): string => `${REPO}${path}`;

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
/** The document's first heading, without inline code marks and issue numbers. */
const title = (path: string): string =>
  (/^#\s+(.+)$/mu.exec(read(path))?.[1] ?? path)
    .replace(/`/gu, "")
    // Square brackets would end the link text early (the manifest contract's title has `[modules]`).
    .replace(/[[\]]/gu, "")
    .replace(/\s*\(#\d+\)\s*$/u, "")
    .replace(/^\d+\s+—\s+/u, "")
    .trim();

/** The developer-facing documents, in reading order, with the line llms.txt shows for each. */
export const DEV_DOCS: readonly [path: string, line: string][] = [
  ["docs/07-app-model.md", "folders are routes: functions/, pages/ with loaders and actions, migrations/, policies/, jobs/, public/; renox.toml; the ctx SDK"],
  ["docs/08-template-engine.md", "HTML-first templates with r-* attributes compiled to minijinja, layouts, partials as <x-name>, fragments, render fuel"],
  ["docs/09-htmx-realtime.md", "htmx fragments, morphing and view transitions; SSE and WebSocket routes with topics and authorization"],
  ["docs/10-modules.md", "the module system: manifest, permissions, services, events, hooks, slots, overrides, tables prefixed <module>__"],
  ["docs/11-authorization.md", "Cedar policies, guard exports, r-can in templates, db.scoped(), roles and 2FA step-up"],
  ["docs/12-developer-experience.md", "installing the CLI and the SDK, renox new/dev/check/test/deploy, building with an AI agent, debugging, limits"],
  ["docs/20-ai-agents-mcp.md", "renox mcp (local) and mcp.renoxium.com (remote) for coding agents, App MCP tools per app, ctx.ai, agent security rules"],
];

/** The contracts: what tenant code and tools can rely on. */
export const CONTRACTS: readonly [path: string, line: string][] = [
  ["docs/contracts/README.md", "the index of the contracts and their versions; the two domains, renoxium.app for tenant apps and renoxium.com for the platform"],
  ["docs/contracts/ops.md", "every op tenant code can call (db, fetch, secrets, log, storage, ai, pdf, realtime, jobs), the limits per tier and what happens at each limit, the error codes"],
  ["docs/contracts/artifact.md", "what renox build produces and renox deploy uploads: manifest, routes, code, templates, migrations, public files"],
  ["docs/contracts/manifest.md", "what a module declares in module.toml and what the tenant approves"],
  ["docs/contracts/deploy-api.md", "the control-plane API the CLI, the dashboard and the remote MCP use"],
  ["docs/contracts/errors.md", "error codes, HTTP statuses and response bodies"],
  ["docs/contracts/meter.md", "the per-request meter record that usage and billing are computed from"],
  ["docs/contracts/client-events.md", "the browser events the renox client script reports"],
];

/** Background documents an agent may want after the developer ones. */
const OPTIONAL: readonly [path: string, line: string][] = [
  ["docs/00-overview.md", "what Renoxium is, the principles, the expectations"],
  ["docs/03-architecture.md", "control plane, data plane, the request path"],
  ["docs/04-isolation-security.md", "the isolation model and the per-tenant limits"],
  ["docs/06-data.md", "one SQLite file per tenant, the authorizer, migrations, replication"],
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
  "(`renox new`, `dev`, `check`, `test`, `deploy`) and the npm package `renox` (types, helpers, test fakes).";

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
    [doc("docs/12-developer-experience.md"), "install the CLI and the SDK, create an app with renox new, run it with renox dev, deploy it"],
    [`[renox CLI reference](${repo("cli/README.md")})`, "every command, exit codes, renox build, renox check, renox test, renox mcp, renox deploy"],
    [`[The renox SDK](${repo("sdk/README.md")})`, "the `renox` npm package: Handler, Ctx, pages, validate, modules, query builders, renox/fakes and renox/test"],
    [`[Example apps](${repo("examples/")})`, "hello (one function), shop (pages, templates, modules, policies), chat (realtime)"],
  ]);
  section("App model", DEV_DOCS.filter(([p]) => !p.endsWith("12-developer-experience.md") && !p.endsWith("20-ai-agents-mcp.md")).map(([p, line]) => [doc(p), line]));
  section("Modules", [
    [doc("docs/10-modules.md"), "how modules are installed (renox add), configured and talk to each other"],
    ...modules().map((m): [string, string] => [`[${m.name}](${repo(`modules/${m.dir}/README.md`)})`, m.description]),
  ]);
  section("CLI", [
    [`[renox CLI reference](${repo("cli/README.md")})`, "renox new, dev, build, check, test, add, remove, migrate, deploy, logs, secrets, db, jobs, authz explain, mcp"],
    [`[Installing the CLI and the SDK](${site("docs/12-developer-experience.md")}#installing-the-cli)`, "signed binaries for Linux and macOS, the npm package at the same version"],
  ]);
  section("MCP for agents", [
    [doc("docs/20-ai-agents-mcp.md"), "the platform MCP (local and remote), App MCP tools, in-app agents with ctx.ai, agent security"],
    [`[Build with an AI agent](${site("docs/12-developer-experience.md")}#build-with-an-ai-agent)`, "connect Claude Code, Cursor or Codex to renox mcp; the remote MCP and its scopes; what agents may and may not do"],
    [`[renox mcp](${repo("cli/README.md")}#renox-mcp)`, "the local server: tools dev_status, dev_errors, run_check, run_tests, search_docs, authz_explain, list_policies, list_tools; resources docs://, config://effective, routes://"],
    [`[Remote platform MCP](${repo("control/api/src/mcp/README.md")})`, "mcp.renoxium.com: OAuth 2.1 with PKCE, scopes apps:read, apps:write, deploy, logs:read, secrets:read; confirmation tokens for mutating tools"],
  ]);
  section("Contracts", CONTRACTS.map(([p, line]) => [doc(p), line]));
  section("Optional", OPTIONAL.map(([p, line]) => [doc(p), line]));
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The files llms-full.txt concatenates, in order. */
export function fullSources(): string[] {
  return [...DEV_DOCS.map(([p]) => p), "cli/README.md", "sdk/README.md", ...modules().map((m) => `modules/${m.dir}/README.md`)];
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
