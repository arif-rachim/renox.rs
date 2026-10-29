// Symbolication of browser stack frames against the private sourcemaps that
// `renox deploy` uploads (PUT .../deployments/{hash}/sourcemaps; deploy-api.md
// section 4, "Sourcemaps"). The maps live in the object store under
// sourcemapKey(tenant, hash) and are never served by any route. Source map v3,
// mappings decoded here (base64 VLQ), no dependency, like cli/src/lib/sourcemap.ts.
//
// A frame `file` is a script URL path (`/islands/cart.js`); its map is
// `public/<path>.map` (a file of public/) or `<path>.map` in the tar.

import { extractTar } from "@renox/artifact-validate";
import { sourcemapKey } from "../deployments/repo.ts";
import { SOURCEMAP_LIMITS } from "../deployments/extract.ts";
import type { ObjectStore } from "../storage/object-store.ts";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_CACHED_DEPLOYMENTS = 16;

export interface Original {
  file: string;
  line: number;
  column: number;
}

/** One decoded segment: generated column, source index, original line, original column (0-based). */
type Segment = [number, number, number, number];

interface Decoded {
  sources: string[];
  /** Per generated line, segments sorted by generated column. */
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
      if (part === "") continue;
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

/**
 * A source path that is safe to show a tenant: relative, no scheme, no `..`
 * (a bundler may record the build machine's layout; none of it is shown).
 */
export function publicSource(source: string): string {
  const path = source.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "").replace(/\\/gu, "/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/").slice(0, 2048);
}

/** The original position of a browser position (line and column 1-based, like the stack; the result uses the same convention). */
export function lookup(d: Decoded, line: number, column: number): Original | null {
  const segs = d.lines[line - 1];
  if (segs === undefined || segs.length === 0) return null;
  const col = Math.max(0, column - 1);
  let best: Segment | undefined;
  for (const s of segs) {
    if (s[0] > col) break;
    best = s;
  }
  if (best === undefined) return null;
  const source = d.sources[best[1]];
  if (source === undefined) return null;
  const file = publicSource(source);
  return file === "" ? null : { file, line: best[2] + 1, column: best[3] + 1 };
}

/** Decoded maps of one deployment, by the map's path in the tar. Parsed on first use. */
class DeploymentMaps {
  private readonly decoded = new Map<string, Decoded | null>();
  constructor(private readonly files: Map<string, Uint8Array>) {}

  mapFor(path: string): Decoded | null {
    for (const key of [`public/${path}.map`, `${path}.map`]) {
      const hit = this.decoded.get(key);
      if (hit !== undefined) {
        if (hit !== null) return hit;
        continue;
      }
      const bytes = this.files.get(key);
      if (bytes === undefined) continue;
      let d: Decoded | null = null;
      try {
        const m = JSON.parse(new TextDecoder().decode(bytes)) as { version?: number; sources?: unknown; mappings?: unknown };
        if (m.version === 3 && Array.isArray(m.sources) && typeof m.mappings === "string") d = decode({ sources: m.sources.map(String), mappings: m.mappings });
      } catch {
        d = null;
      }
      this.decoded.set(key, d);
      if (d !== null) return d;
    }
    return null;
  }
}

export class Symbolicator {
  private readonly cache = new Map<string, DeploymentMaps | null>();
  constructor(private readonly store: ObjectStore) {}

  private async maps(tenant: string, hash: string): Promise<DeploymentMaps | null> {
    const key = `${tenant}/${hash}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    let loaded: DeploymentMaps | null = null;
    try {
      const tar = await this.store.get(sourcemapKey(tenant, hash));
      if (tar !== null) loaded = new DeploymentMaps(await extractTar(tar, { gzip: false, limits: SOURCEMAP_LIMITS }));
    } catch {
      loaded = null;
    }
    // A deployment without maps is not cached: they may be uploaded a moment after the first event.
    if (loaded === null) return null;
    this.cache.set(key, loaded);
    if (this.cache.size > MAX_CACHED_DEPLOYMENTS) this.cache.delete(this.cache.keys().next().value as string);
    return loaded;
  }

  /** The original position of `file:line:column` in `hash`, or null when no map of that deployment covers it. */
  async original(tenant: string, hash: string, file: string, line: number, column: number): Promise<Original | null> {
    if (!file.startsWith("/") || file.startsWith("//") || line < 1) return null;
    const maps = await this.maps(tenant, hash);
    const map = maps?.mapFor(file.replace(/[?#].*$/u, "").slice(1)) ?? null;
    return map === null ? null : lookup(map, line, column);
  }
}
