// Templates at build time (#43; docs/08-template-engine.md, "Compile
// pipeline"; artifact.md section 3, "Templates"): the app's HTML templates
// are transpiled to minijinja by `renox-worker transpile`, the compiler of
// crates/renox-template behind a stdin/stdout JSON call.
//
// Why the worker and not a Wasm build of renox-template: the issue asked to
// measure both cold on the shop templates (bench/scenarios/B16/transpile.ts,
// README "Templates"). Spawning the worker was faster (p50 9.0 ms against
// 17.5 ms to instantiate the 1.2 MB module and compile), and `renox dev`
// already needs the binary. An app without templates never calls it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { location, ValidationError, type Where } from "../errors.ts";
import { sha256Hex } from "./hash.ts";
import { workerPath } from "./worker.ts";

export interface FragmentEntry {
  target: string | null;
}

export interface CompiledTemplate {
  kind: "page" | "layout" | "partial" | "error" | "not_found";
  /** minijinja source: `templates/<id>.jinja`. */
  source: string;
  /** Pages: the fragment map (artifact.md, "Templates"). */
  fragments?: Record<string, FragmentEntry>;
}

export interface TemplateDiagnostic {
  file: string;
  line: number;
  col: number;
  message: string;
}

/** Template compile errors: every diagnostic with its file and line (exit 2). */
export class TemplateError extends ValidationError {
  constructor(readonly diagnostics: TemplateDiagnostic[]) {
    const [first] = diagnostics;
    const where = (d: TemplateDiagnostic): Where => (d.file ? { file: d.file, line: d.line, column: d.col } : {});
    super(
      diagnostics.length === 1 && first
        ? first.message
        : `${diagnostics.length} template errors:\n  ${diagnostics.map((d) => `${location(where(d)) ? `${location(where(d))}: ` : ""}${d.message}`).join("\n  ")}`,
      diagnostics.length === 1 && first ? { ...where(first), hint: "fix the template, then save again" } : { hint: "fix the templates above, then save again" },
    );
  }

  /** One `Where` per diagnostic, for `renox check`. */
  locations(): { message: string; where: Where }[] {
    return this.diagnostics.map((d) => ({ message: d.message, where: d.file ? { file: d.file, line: d.line, column: d.col } : {} }));
  }
}

/** Directories whose `.html` files are template sources (compiler module doc). */
const ROOTS = ["pages", "partials", "modules", "overrides"];

function htmlFiles(dir: string, rel: string, out: Record<string, string>): void {
  let entries;
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    if (d.name.startsWith(".")) continue;
    const r = `${rel}/${d.name}`;
    if (d.isDirectory()) htmlFiles(dir, r, out);
    else if (d.isFile() && d.name.endsWith(".html")) out[r] = readFileSync(join(dir, r), "utf8");
  }
}

/** The app's template files by app-relative path (`pages/index.html`). */
export function templateFiles(project: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const root of ROOTS) htmlFiles(project, root, out);
  return out;
}

/** Last compile, for `renox dev`: a rebuild with unchanged templates skips the worker. */
export class TemplateCache {
  private entry: { key: string; templates: Record<string, CompiledTemplate> } | undefined;

  get(key: string): Record<string, CompiledTemplate> | undefined {
    return this.entry?.key === key ? this.entry.templates : undefined;
  }

  set(key: string, templates: Record<string, CompiledTemplate>): void {
    this.entry = { key, templates };
  }
}

export const templatesKey = (files: Record<string, string>): string =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))));

/**
 * Transpiles `files` with `renox-worker transpile`. Throws TemplateError
 * with every diagnostic, or an EnvironmentError (exit 3) when there is no
 * worker binary.
 */
export async function transpile(
  files: Record<string, string>,
  worker = workerPath(),
  slots?: Record<string, { template: string; requires?: string }[]>,
): Promise<Record<string, CompiledTemplate>> {
  const p = Bun.spawn([worker, "transpile"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  // The slot registry (artifact.md 1.1, "Slots") compiles into the `<r-slot>` includes.
  p.stdin.write(JSON.stringify(slots && Object.keys(slots).length ? { files, slots } : { files }));
  await p.stdin.end();
  const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new ValidationError(`renox-worker transpile failed (exit code ${code}): ${err.trim()}`);
  const out = JSON.parse(text) as { ok: true; templates: Record<string, CompiledTemplate> } | { ok: false; diagnostics: TemplateDiagnostic[] };
  if (!out.ok) throw new TemplateError(out.diagnostics);
  return out.templates;
}
