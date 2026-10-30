// `createAppFromTemplate` (#326; deploy-api.md 0.5 section 21): the first
// app of a new tenant in one call. The templates are artifacts built from
// `examples/` ahead of time and kept under `CONTROL_TEMPLATES_DIR`, one
// directory per template (`<dir>/<template>/manifest.json`, or the
// `<hash>/` directory `renox build --out <dir>/<template>` writes).
//
// An artifact's manifest names its app (artifact.md rule V3), so the
// template's `app.name` is set to the new app's name, which gives the tree a
// hash of its own. The app is then created, the tree uploaded and activated
// through the API's own routes with the caller's credentials, so their
// validation, scope checks and audit rows apply unchanged.
//
//   bun control/api/src/signup/templates.ts <out>   builds hello and shop from examples/ into <out>

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { contentHash, writeTar } from "@renox/artifact-validate";
import type { Context, Hono } from "hono";

import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import { check } from "../contract.ts";
import type { Deps, Env } from "../context.ts";
import { conflict, invalid } from "../errors.ts";
import { readBody } from "../http.ts";
import { requestScope } from "../tenancy/scope.ts";

/** deploy-api.yaml `createAppFromTemplate` `template`. */
export const TEMPLATES = ["hello", "shop", "booking", "invoices"] as const;
export type Template = (typeof TEMPLATES)[number];

/** Every file of an artifact tree, by its path inside the tree. */
function readTree(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const visit = (p: string): void => {
    for (const name of readdirSync(p).sort()) {
      const full = join(p, name);
      if (statSync(full).isDirectory()) visit(full);
      else files.set(relative(dir, full), new Uint8Array(readFileSync(full)));
    }
  };
  visit(dir);
  return files;
}

/** The template's artifact tree, or null when it was not built into `root`. */
export function templateFiles(root: string | undefined, template: Template): Map<string, Uint8Array> | null {
  if (root === undefined || root === "") return null;
  let dir = join(root, template);
  if (!existsSync(dir)) return null;
  if (!existsSync(join(dir, "manifest.json"))) {
    // `renox build --out` writes one `<hash>/` directory.
    const inner = readdirSync(dir).filter((n) => /^[0-9a-f]{64}$/u.test(n));
    if (inner.length !== 1) return null;
    dir = join(dir, inner[0] as string);
  }
  return readTree(dir);
}

/** The tree with `app.name` set to `app` (rule V3); its hash changes with it. */
export function renamed(files: ReadonlyMap<string, Uint8Array>, app: string): Map<string, Uint8Array> {
  const out = new Map(files);
  const raw = files.get("manifest.json");
  if (raw === undefined) throw new Error("a template without manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as { app: { name: string } };
  manifest.app.name = app;
  out.set("manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  return out;
}

/** The caller's credentials and request headers, for the API's own routes. */
function forwarded(c: Context<Env>): Record<string, string> {
  const out: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    if (k !== "content-type" && k !== "content-length" && k !== "host") out[k] = v;
  });
  return out;
}

export function registerTemplates(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/apps/from-template", operation(deps, "createAppFromTemplate"), tenantAuth(deps, "apps:write"), async (c) => {
    if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, 4096))) as Record<string, unknown>;
    } catch {
      throw invalid("body", "must be a JSON object");
    }
    if (Object.keys(b).some((k) => k !== "name" && k !== "template")) throw invalid("body", "only name and template");
    let name: string;
    try {
      name = check<string>("AppName", b.name);
    } catch {
      throw invalid("name", "must be an app name");
    }
    const template = TEMPLATES.find((t) => t === b.template);
    if (template === undefined) throw invalid("template", `one of ${TEMPLATES.join(", ")}`);
    const files = templateFiles(process.env.CONTROL_TEMPLATES_DIR, template);
    if (files === null) throw conflict("template", "not available on this control plane");
    const tree = renamed(files, name);
    const hash = contentHash(tree);
    const headers = forwarded(c);
    const step = (method: string, path: string, body: BodyInit, type: string, extra: Record<string, string> = {}) =>
      // Each step is a request of its own, outside this request's tenant scope.
      requestScope.exit(() => app.request(path, { method, headers: { ...headers, "content-type": type, ...extra }, body }, c.env));
    // 1. The app; 409 when the name is taken, answered as it is.
    const created = await step("POST", "/v1/apps", JSON.stringify({ name }), "application/json");
    if (created.status !== 201) return created;
    const view = (await created.json()) as { hostnames?: string[] };
    // 2. The template's tree, validated like any upload.
    const uploaded = await step("POST", `/v1/apps/${encodeURIComponent(name)}/deployments`, writeTar(tree), "application/x-tar", { "x-renox-artifact-hash": hash });
    if (uploaded.status !== 201 && uploaded.status !== 200) return uploaded;
    // 3. Activation; 503 when no node is healthy.
    const activated = await step("POST", `/v1/apps/${encodeURIComponent(name)}/activate`, JSON.stringify({ hash }), "application/json");
    if (activated.status !== 200) return activated;
    c.set("auditTarget", { app: name, template, hash });
    const host = view.hostnames?.[0] ?? `${name}.${deps.config.platformDomain}`;
    return c.json({ app: name, template, hash, url: `https://${host}` }, 201);
  });
}

if (import.meta.main) {
  const out = process.argv[2];
  if (out === undefined) {
    process.stderr.write("usage: templates.ts <out>\n");
    process.exit(2);
  }
  const { buildArtifact } = await import("../../../../cli/src/lib/build.ts");
  const examples = new URL("../../../../examples/", import.meta.url).pathname;
  for (const t of TEMPLATES) {
    if (!existsSync(join(examples, t, "renox.toml"))) {
      process.stderr.write(`skip ${t}: no examples/${t}\n`);
      continue;
    }
    const r = await buildArtifact(join(examples, t), join(out, t));
    process.stdout.write(`${t} ${r.hash}\n`);
  }
}
