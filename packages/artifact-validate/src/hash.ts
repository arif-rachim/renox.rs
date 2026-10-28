// The artifact content hash (docs/contracts/artifact.md section 2).

import { createHash } from "node:crypto";

const encoder = new TextEncoder();

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** Compares two strings by their UTF-8 bytes (LC_ALL=C order). */
export function compareUtf8(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  }
  return x.length - y.length;
}

/** SHA-256 over "<sha256 hex>  <path>\n" lines sorted by UTF-8 path bytes. */
export function contentHash(files: ReadonlyMap<string, Uint8Array>): string {
  const listing = [...files.keys()]
    .sort(compareUtf8)
    .map((path) => `${sha256Hex(files.get(path) as Uint8Array)}  ${path}\n`)
    .join("");
  return sha256Hex(listing);
}
