// MCP resources of the local platform server (docs/20-ai-agents-mcp.md,
// "Resources"): the embedded documentation, the contract's ctx types, the
// resolved renox.toml, and the project's route table. A URI is looked up in
// these fixed sets; no part of it reaches the file system.

import { type ProjectConfig, readProject } from "../lib/project.ts";
import { discoverFunctions, routeConflicts, routesOf, sortRoutes } from "../lib/routes.ts";
import { problemOf } from "./devstate.ts";
import { CTX_TYPES, DOCS, titleOf } from "./docs.ts";

export interface Resource {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

const CONFIG = "config://effective";
const ROUTES = "routes://";
const TYPES = "types://renox/ctx.d.ts";

export function listResources(): Resource[] {
  const docs = Object.keys(DOCS).map((path) => ({
    uri: `docs://${path}`,
    name: path,
    title: titleOf(path),
    description: `Renox documentation: docs/${path}`,
    mimeType: "text/markdown",
  }));
  return [
    {
      uri: CONFIG,
      name: "config",
      title: "Effective renox.toml",
      description: "The project's renox.toml as the CLI resolves it (defaults filled in), or the configuration problem",
      mimeType: "application/json",
    },
    {
      uri: ROUTES,
      name: "routes",
      title: "Route table",
      description: "The routes `renox build` would emit for this project, in matching order, with any route conflicts",
      mimeType: "application/json",
    },
    {
      uri: TYPES,
      name: "ctx.d.ts",
      title: "ctx types",
      description: "The TypeScript view of the ctx contract (docs/contracts/ctx.d.ts) that the `renox` SDK re-exports",
      mimeType: "text/x-typescript",
    },
    ...docs,
  ];
}

const json = (uri: string, value: unknown): ResourceContents => ({
  uri,
  mimeType: "application/json",
  text: `${JSON.stringify(value, null, 2)}\n`,
});


/** The contents of `uri`, or null when there is no such resource. */
export function readResource(uri: string, project: string): ResourceContents | null {
  if (uri.startsWith("docs://")) {
    const path = uri.slice("docs://".length);
    const text = Object.hasOwn(DOCS, path) ? DOCS[path] : undefined;
    return text === undefined ? null : { uri, mimeType: "text/markdown", text };
  }
  if (uri === TYPES) return { uri, mimeType: "text/x-typescript", text: CTX_TYPES };
  if (uri === CONFIG) {
    try {
      const config: ProjectConfig = readProject(project);
      return json(uri, { ok: true, config });
    } catch (e) {
      return json(uri, { ok: false, problems: [problemOf(e)] });
    }
  }
  if (uri === ROUTES) {
    try {
      const routes = sortRoutes(routesOf(discoverFunctions(project)));
      return json(uri, { ok: true, routes, conflicts: routeConflicts(routes) });
    } catch (e) {
      return json(uri, { ok: false, problems: [problemOf(e)] });
    }
  }
  return null;
}
