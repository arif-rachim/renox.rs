// Content-hashed names for the public/ files a template links (#406).
//
// The gateway serves a public/ path whose file name carries a content hash
// (`site.3f2a9c1b5d6e7f80.css`) with `Cache-Control: public, max-age=31536000,
// immutable`, and every other path with `max-age=0, must-revalidate`
// (crates/renox-gateway/src/static_files.rs, `is_hashed_path`). An app writes
// `<link rel="stylesheet" href="/site.css">`; the build adds a copy of
// `public/site.css` under `site.<16 hex of its sha256>.css` and points the
// template's literal `href`/`src` at it, so a browser (and Cloudflare in
// front of the worker) keeps the file until the next deploy changes its
// name, and never revalidates it in between. The original path stays in the
// artifact for anything else that names it (a script's fetch, an external
// link).
//
// Only literal attribute values are rewritten: `href="/x.css"` or
// `src='/x.js'` on any element, whose path is a file of public/ with an
// extension and no query or fragment. A bound `:href`, a value with
// `{{ }}`, a path already hashed, and a path that is not in public/ are left
// as they are.

import { sha256Hex } from "./hash.ts";

/** Hex characters of the file's sha256 that go into its name. */
export const HASH_CHARS = 16;

/**
 * Whether the file name already carries a content hash, by the gateway's
 * rule: a `.`/`-` separated part of at least 8 hex characters before the
 * extension.
 */
export function isHashedPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const stem = name.slice(0, dot);
  const cut = Math.max(stem.lastIndexOf("."), stem.lastIndexOf("-"));
  if (cut < 0) return false;
  const part = stem.slice(cut + 1);
  return part.length >= 8 && /^[0-9a-fA-F]+$/u.test(part);
}

/** `/dir/site.css` with sha256 `3f2a…` → `/dir/site.3f2a9c1b5d6e7f80.css`. */
export function hashedName(path: string, sha256: string): string {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return `${path.slice(0, slash + 1)}${name.slice(0, dot)}.${sha256.slice(0, HASH_CHARS)}${name.slice(dot)}`;
}

/** A literal `href`/`src` value: whitespace, the name, `=`, a quote, a root path, the same quote. */
const ATTR = /(\s)(href|src)=(["'])(\/[^"'?#\s{}<>]*)\3/gu;

export interface AssetRewrite {
  /** The template sources with the linked public paths pointing at their hashed names. */
  sources: Record<string, string>;
  /** Public path → hashed path, for every file a template links. */
  aliases: Map<string, string>;
}

/**
 * Points literal `href`/`src` values at hashed names. `hashes` maps every
 * public/ path (`/site.css`) to its sha256; a hashed name that is itself a
 * file of public/ is not used (that file keeps its own contents).
 */
export function rewriteAssetRefs(sources: Record<string, string>, hashes: ReadonlyMap<string, string>): AssetRewrite {
  const aliases = new Map<string, string>();
  const out: Record<string, string> = {};
  for (const [file, text] of Object.entries(sources)) {
    out[file] = text.replace(ATTR, (whole, space: string, attr: string, quote: string, path: string) => {
      const sha = hashes.get(path);
      if (sha === undefined || isHashedPath(path)) return whole;
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (name.lastIndexOf(".") <= 0) return whole;
      const hashed = hashedName(path, sha);
      if (hashes.has(hashed)) return whole;
      aliases.set(path, hashed);
      return `${space}${attr}=${quote}${hashed}${quote}`;
    });
  }
  return { sources: out, aliases };
}

/** The sha256 of each public file, keyed by its URL path. */
export function publicHashes(files: Iterable<[string, Uint8Array]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [p, bytes] of files) m.set(p, sha256Hex(bytes));
  return m;
}
