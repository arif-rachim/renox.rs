// Bun macro (imported `with { type: "macro" }`): runs at transpile time, so
// `bun build --compile` inlines the documentation into the binary, which does
// not ship docs/ (#48, gate F1 note).

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS = join(import.meta.dir, "..", "..", "..", "docs");
const SITE_DOCS = join(import.meta.dir, "..", "..", "..", "www", "lib", "docs.ts");

/**
 * The markdown files under docs/ that the site publishes (#478): the `path:`
 * entries of the allowlist `PUBLISHED` in `www/lib/docs.ts`, read from that
 * file so the two cannot drift. The READMEs and `ctx.d.ts` it also lists are
 * not under docs/ or not markdown; `embedCtxTypes` carries the latter.
 */
export function publishedDocPaths(): string[] {
  const source = readFileSync(SITE_DOCS, "utf8");
  const paths = [...source.matchAll(/\bpath:\s*"docs\/([^"]+\.md)"/gu)].map((m) => m[1] as string);
  if (paths.length === 0) throw new Error(`no published docs found in ${SITE_DOCS}`);
  return [...new Set(paths)].sort();
}

/** The published docs (`docs/**` per the site's allowlist, the tutorial included), keyed by their path under docs/. */
export function embedDocs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of publishedDocPaths()) out[rel] = readFileSync(join(DOCS, rel), "utf8");
  return out;
}

/** The contract's TypeScript view of `ctx` (the types tenant code is written against). */
export function embedCtxTypes(): string {
  return readFileSync(join(DOCS, "contracts", "ctx.d.ts"), "utf8");
}
