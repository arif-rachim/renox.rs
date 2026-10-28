// Bun macro (imported `with { type: "macro" }`): runs at transpile time, so
// `bun build --compile` inlines the documentation into the binary, which does
// not ship docs/ (#48, gate F1 note).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS = join(import.meta.dir, "..", "..", "..", "docs");

/** `docs/*.md` and `docs/contracts/*.md`, keyed by their path under docs/. */
export function embedDocs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sub of ["", "contracts"]) {
    for (const name of readdirSync(join(DOCS, sub)).sort()) {
      if (!name.endsWith(".md")) continue;
      const rel = sub ? `${sub}/${name}` : name;
      out[rel] = readFileSync(join(DOCS, rel), "utf8");
    }
  }
  return out;
}

/** The contract's TypeScript view of `ctx` (the types tenant code is written against). */
export function embedCtxTypes(): string {
  return readFileSync(join(DOCS, "contracts", "ctx.d.ts"), "utf8");
}
