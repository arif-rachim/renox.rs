// Server stack traces in the `renox dev` terminal, mapped back to the
// TypeScript sources (gate note on #43): the bundle's positions
// (`file:///pages/products/index.js:3:11`) are looked up in the source maps
// `renox build` writes to `.renox/sourcemaps/<hash>/` (#143). Source map v3,
// decoded here (base64 VLQ), no dependency.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** One decoded segment: generated column, source index, original line, original column (all 0-based). */
type Segment = [number, number, number, number];

interface Decoded {
  sources: string[];
  /** Per generated line, its segments sorted by generated column. */
  lines: Segment[][];
}

function vlq(s: string, at: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const digit = B64.indexOf(s[at.i++] ?? "");
    if (digit < 0) throw new Error("bad VLQ");
    result += (digit & 31) << shift;
    if (!(digit & 32)) break;
    shift += 5;
  }
  return result & 1 ? -(result >>> 1) : result >>> 1;
}

export function decode(map: { sources: string[]; mappings: string }): Decoded {
  const lines: Segment[][] = [];
  let src = 0;
  let oLine = 0;
  let oCol = 0;
  for (const text of map.mappings.split(";")) {
    const segs: Segment[] = [];
    let gCol = 0;
    for (const part of text.split(",")) {
      if (!part) continue;
      const at = { i: 0 };
      gCol += vlq(part, at);
      if (at.i >= part.length) continue;
      src += vlq(part, at);
      oLine += vlq(part, at);
      oCol += vlq(part, at);
      segs.push([gCol, src, oLine, oCol]);
    }
    lines.push(segs);
  }
  return { sources: map.sources, lines };
}

/** The original position of a generated 1-based line and column. */
export function lookup(d: Decoded, line: number, column: number): { source: string; line: number; column: number } | undefined {
  const segs = d.lines[line - 1];
  if (!segs?.length) return undefined;
  let best: Segment | undefined;
  for (const s of segs) {
    if (s[0] <= column - 1) best = s;
    else break;
  }
  best ??= segs[0];
  if (!best) return undefined;
  const source = d.sources[best[1]];
  return source === undefined ? undefined : { source, line: best[2] + 1, column: best[3] + 1 };
}

/** Rewrites `file:///<path>.js:L:C` frames of a stack to the original sources. */
export class Symbolicator {
  private cache = new Map<string, Decoded | null>();

  constructor(private readonly mapsDir: () => string) {}

  private map(path: string): Decoded | null {
    const file = join(this.mapsDir(), `${path}.map`);
    const key = file;
    if (!this.cache.has(key)) {
      try {
        this.cache.set(key, existsSync(file) ? decode(JSON.parse(readFileSync(file, "utf8"))) : null);
      } catch {
        this.cache.set(key, null);
      }
    }
    return this.cache.get(key) ?? null;
  }

  stack(text: string): string {
    return text.replace(/file:\/\/\/([^\s():]+\.m?js):(\d+):(\d+)/gu, (all, path: string, l: string, c: string) => {
      const d = this.map(path);
      const pos = d && lookup(d, Number(l), Number(c));
      return pos ? `${pos.source}:${pos.line}:${pos.column}` : all;
    });
  }
}
