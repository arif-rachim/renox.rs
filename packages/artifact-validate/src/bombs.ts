// Generated hostile uploads, one per upload rule (docs/contracts/deploy-api.md
// section 4, T1-T8; docs/23-failure-modes.md "Tarball decompression bomb /
// too many files"). Large bombs are lazy streams that count what was pulled
// from them, so a test can prove the reader stopped long before the end.
//
// Used by this package's tests, by control/api's upload tests (#95), and by
// `bun packages/artifact-validate/src/bombs.ts <dir>`, which writes the small
// ones as files for the worker's Rust loader (#55) to run against.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const enc = new TextEncoder();
const MiB = 1024 * 1024;

/** One raw ustar header block, any type, any name (writeTar never writes these). */
export function rawHeader(name: string, size: number, type: string, linkname = ""): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number) => h.set(enc.encode(s), at);
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put(type, 156);
  put(linkname, 157);
  put("ustar\0", 257);
  put("00", 263);
  for (let i = 148; i < 156; i++) h[i] = 32;
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

const END = new Uint8Array(1024);

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const padTo512 = (n: number): Uint8Array => new Uint8Array((512 - (n % 512)) % 512);

export interface Bomb {
  /** The rule the reader must stop on. */
  rule: "T1" | "T2" | "T3" | "T4" | "T5" | "T6";
  name: string;
  gzip: boolean;
  /** A fresh stream of the upload body; call once per upload. */
  body(): ReadableStream<Uint8Array>;
  /** Bytes of the plain tar (before gzip) that the last body() stream produced so far. */
  produced(): number;
  /** Bytes of the plain tar if it were read to the end. */
  fullSize: number;
  /** True when body() produces bytes only as they are read, so produced() shows where the reader stopped. */
  streamed: boolean;
}

/** A small bomb whose bytes are all in memory. */
function small(rule: Bomb["rule"], name: string, bytes: Uint8Array): Bomb {
  let produced = 0;
  return {
    rule,
    name,
    gzip: false,
    fullSize: bytes.length,
    streamed: false,
    produced: () => produced,
    body: () =>
      new ReadableStream({
        start(c) {
          produced = bytes.length;
          c.enqueue(bytes);
          c.close();
        },
      }),
  };
}

/**
 * A lazy tar: `parts` yields chunks on demand, 64 KiB of file data at a
 * time, and `produced` counts them. With `gzip`, the chunks go through a
 * CompressionStream, so the compressed body is also produced on demand.
 */
function lazy(rule: Bomb["rule"], name: string, gzip: boolean, fullSize: number, parts: () => Generator<Uint8Array>): Bomb {
  let produced = 0;
  return {
    rule,
    name,
    gzip,
    fullSize,
    streamed: true,
    produced: () => produced,
    body() {
      produced = 0;
      const it = parts();
      const plain = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            const next = it.next();
            if (next.done) c.close();
            else {
              produced += next.value.length;
              c.enqueue(next.value);
            }
          },
        },
        { highWaterMark: 0 },
      );
      return gzip ? plain.pipeThrough(new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>) : plain;
    },
  };
}

function* data(size: number, fill: (chunk: Uint8Array) => void = () => {}): Generator<Uint8Array> {
  const CHUNK = 64 * 1024;
  for (let left = size; left > 0; left -= CHUNK) {
    const chunk = new Uint8Array(Math.min(CHUNK, left));
    fill(chunk);
    yield chunk;
  }
  yield padTo512(size);
}

const random = (chunk: Uint8Array): void => {
  for (let at = 0; at < chunk.length; at += 65_536) crypto.getRandomValues(chunk.subarray(at, Math.min(chunk.length, at + 65_536)));
};

/** T6: `total` zero bytes in 16 MiB files (each under the T5 cap), gzipped (about 1000:1). */
export function highRatio(total = 2 * 1024 * MiB): Bomb {
  const each = 16 * MiB;
  const count = Math.ceil(total / each);
  return lazy("T6", "high-ratio gzip", true, count * (512 + each) + 1024, function* () {
    for (let i = 0; i < count; i++) {
      yield rawHeader(`public/z${i}.bin`, each, "0");
      yield* data(each);
    }
    yield END;
  });
}

/** T3: `count` empty files. */
export function manyEntries(count = 10_001): Bomb {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) parts.push(rawHeader(`public/f${i}`, 0, "0"));
  parts.push(END);
  return small("T3", "many entries", concat(parts));
}

/** T4: a file `depth` segments deep. */
export const deepPath = (depth = 33): Bomb =>
  small("T4", "deep path", concat([rawHeader(`${Array.from({ length: depth - 1 }, () => "d").join("/")}/f`, 0, "0"), END]));

/** T1: a symbolic link to /etc/passwd. */
export const symlink = (): Bomb => small("T1", "symlink", concat([rawHeader("code/link", 0, "2", "/etc/passwd"), END]));

/** T1: a hard link. */
export const hardlink = (): Bomb => small("T1", "hard link", concat([rawHeader("code/link", 0, "1", "manifest.json"), END]));

/** T1: a character device. */
export const device = (): Bomb => small("T1", "device", concat([rawHeader("code/null", 0, "3"), END]));

/** T4: an absolute path. */
export const absolutePath = (): Bomb => small("T4", "absolute path", concat([rawHeader("/etc/cron.d/x", 1, "0"), new Uint8Array(512), END]));

/** T4: a path that climbs out with `..`. */
export const dotDot = (): Bomb => small("T4", "path escape", concat([rawHeader("code/../../x", 1, "0"), new Uint8Array(512), END]));

/** T5: one entry of `size` bytes (over the 20 MiB entry cap); the reader must stop at its header. */
export const oversizedEntry = (size = 64 * MiB): Bomb =>
  lazy("T5", "oversized entry", false, 512 + size + 1024, function* () {
    yield rawHeader("code/big.bin", size, "0");
    yield* data(size);
    yield END;
  });

/**
 * T2: `count` random (incompressible) files of `size` bytes, together over the
 * 100 MiB total; the reader must stop at the header that crosses it.
 */
export const totalOverflow = (size = 18 * MiB, count = 8): Bomb =>
  lazy("T2", "total size", false, count * (512 + size) + 1024, function* () {
    for (let i = 0; i < count; i++) {
      yield rawHeader(`public/r${i}.bin`, size, "0");
      yield* data(size, random);
    }
    yield END;
  });

/** Every bomb, with the default sizes. */
export const allBombs = (): Bomb[] => [highRatio(), manyEntries(), deepPath(), symlink(), hardlink(), device(), absolutePath(), dotDot(), oversizedEntry(), totalOverflow()];

/** Writes the bombs whose plain tar is under 16 MiB to `dir` as `<rule>-<name>.tar`, for other implementations. */
export async function writeCorpus(dir: string): Promise<string[]> {
  const written: string[] = [];
  for (const b of allBombs()) {
    if (b.gzip || b.fullSize > 16 * MiB) continue;
    const bytes = new Uint8Array(await new Response(b.body()).arrayBuffer());
    const file = join(dir, `${b.rule}-${b.name.replaceAll(" ", "-")}.tar`);
    writeFileSync(file, bytes);
    written.push(file);
  }
  return written;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) {
    process.stderr.write("usage: bun packages/artifact-validate/src/bombs.ts <dir>\n");
    process.exit(2);
  }
  for (const f of await writeCorpus(dir)) process.stdout.write(`${f}\n`);
}
