// The artifact content hash (docs/contracts/artifact.md section 2), the
// TypeScript twin of crates/renox-cell/src/artifact.rs. Both are checked
// against docs/contracts/examples/hash-vectors.json.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

const encoder = new TextEncoder();

/** Compare two strings by their UTF-8 bytes (LC_ALL=C order). */
export function compareUtf8(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** One `<sha256>  <path>\n` line per file, sorted by path bytes. */
export function canonicalListing(files: Map<string, Uint8Array>): string {
  return [...files.keys()]
    .sort(compareUtf8)
    .map((p) => `${sha256Hex(files.get(p) as Uint8Array)}  ${p}\n`)
    .join("");
}

export const hashFiles = (files: Map<string, Uint8Array>): string => sha256Hex(canonicalListing(files));

/** Every regular file under `dir` by artifact-relative path. Symbolic links are refused (V1). */
export function readTree(dir: string, prefix = ""): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const d of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isSymbolicLink()) throw new Error(`V1: symbolic link ${rel}`);
    if (d.isDirectory()) for (const [k, v] of readTree(dir, rel)) out.set(k, v);
    else if (d.isFile()) out.set(rel, new Uint8Array(readFileSync(join(dir, rel))));
    else throw new Error(`V1: special file ${rel}`);
  }
  return out;
}

export const hashDir = (dir: string): string => hashFiles(readTree(dir));
