// Builds renox-client.js (#127): sdk/client/src/main.ts → sdk/client/dist/
// (minified IIFE plus an external source map that is never served), and
// copies the script to crates/renox-gateway/assets/renox-client.js, which the
// gateway embeds (a Rust build needs no Bun). sdk/client/tests/build.test.ts
// fails when the committed asset differs from a fresh build or is over 4 KB
// gzipped.
//
//   bun sdk/client/build.ts

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
export const ASSET = join(ROOT, "crates", "renox-gateway", "assets", "renox-client.js");
/** The size limit, gzipped. */
export const MAX_GZIP_BYTES = 4096;

const DEBUG_ID = /\/\/# debugId=[0-9A-Fa-f-]+\n?/u;

/**
 * The debug id of a build (#268): the first 128 bits of the SHA-256 of the
 * script without its debug id comment, as 32 upper-case hex digits. Bun's
 * own id also depends on the output path, so two machines (or a temporary
 * directory and `dist/`) disagreed for the same source.
 */
export function debugIdOf(script: string): string {
  return new Bun.CryptoHasher("sha256").update(script.replace(DEBUG_ID, "")).digest("hex").slice(0, 32).toUpperCase();
}

/** Builds into `outdir`; returns the script's path. */
export async function build(outdir = join(import.meta.dir, "dist")): Promise<string> {
  mkdirSync(outdir, { recursive: true });
  const r = await Bun.build({
    entrypoints: [join(import.meta.dir, "src", "main.ts")],
    outdir,
    naming: "renox-client.js",
    target: "browser",
    format: "iife",
    minify: true,
    sourcemap: "external",
  });
  if (!r.success) throw new AggregateError(r.logs, "renox-client.js build failed");
  const out = join(outdir, "renox-client.js");
  const script = readFileSync(out, "utf8");
  const id = debugIdOf(script);
  writeFileSync(out, DEBUG_ID.test(script) ? script.replace(DEBUG_ID, `//# debugId=${id}\n`) : script);
  const map = `${out}.map`;
  if (existsSync(map)) {
    const doc = JSON.parse(readFileSync(map, "utf8")) as Record<string, unknown>;
    if ("debugId" in doc) writeFileSync(map, JSON.stringify({ ...doc, debugId: id }));
  }
  return out;
}

if (import.meta.main) {
  const out = await build();
  copyFileSync(out, ASSET);
  const bytes = Bun.gzipSync(await Bun.file(out).bytes()).length;
  console.log(`renox-client.js: ${Bun.file(out).size} bytes, ${bytes} gzipped (limit ${MAX_GZIP_BYTES}) → ${ASSET}`);
  if (bytes > MAX_GZIP_BYTES) process.exit(1);
}
