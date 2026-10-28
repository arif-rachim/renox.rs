// Artifact tarballs (docs/contracts/deploy-api.md section 4): a streaming
// reader that applies the upload rules T1-T8 while it reads, so nothing beyond
// a cap is ever buffered, and a deterministic writer.
//
// Accepted entries: regular files ('0', NUL), directories ('5'), and pax
// extended headers ('x', read for `path` and `size` only). Everything else,
// links and devices included, is T1.

import { pathProblem } from "./paths.ts";
import type { Violation } from "./artifact.ts";

export interface TarLimits {
  /** Bytes as sent (compressed or not). Over it: InputTooLarge, which the API answers with 413. */
  maxInputBytes: number;
  /** T2: total bytes of all file entries. */
  maxTotalBytes: number;
  /** T3: entries, files and directories. */
  maxEntries: number;
  /** T5: bytes of one file entry. */
  maxEntryBytes: number;
  /** T6: decompressed ÷ compressed bytes, checked once `ratioAfterBytes` are decompressed. */
  maxRatio: number;
  ratioAfterBytes: number;
  /** T8: wall-clock milliseconds for reading and extracting. */
  timeoutMs: number;
}

const MiB = 1024 * 1024;

/** The caps of deploy-api.md section 4. */
export const UPLOAD_LIMITS: TarLimits = {
  maxInputBytes: 100 * MiB,
  maxTotalBytes: 100 * MiB,
  maxEntries: 10_000,
  maxEntryBytes: 20 * MiB,
  maxRatio: 50,
  ratioAfterBytes: 1 * MiB,
  timeoutMs: 30_000,
};

/** The upload broke a T rule; extraction stopped there. */
export class TarRejected extends Error {
  constructor(readonly violation: Violation) {
    super(`${violation.rule}: ${violation.reason}`);
  }
}

/** The body is over `maxInputBytes`. */
export class InputTooLarge extends Error {}

const reject = (rule: string, reason: string, path?: string): TarRejected =>
  new TarRejected(path === undefined ? { rule, reason } : { rule, path, reason });

const BLOCK = 512;
const MAX_PAX_BYTES = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Pulls exact byte counts out of a chunk stream, with a deadline on every read. */
class ByteReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly deadline: number,
    private readonly now: () => number,
    private readonly onChunk: (n: number) => void,
  ) {}

  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const remaining = this.deadline - this.now();
    if (remaining <= 0) throw reject("T8", "extraction took longer than the time limit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(reject("T8", "extraction took longer than the time limit")), remaining);
    });
    try {
      const { value, done } = await Promise.race([this.reader.read(), timeout]);
      if (done) {
        this.done = true;
        return false;
      }
      this.onChunk(value.byteLength);
      this.chunks.push(value);
      this.buffered += value.byteLength;
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exactly `n` bytes, or null at a clean end of stream before the first byte. */
  async read(n: number): Promise<Uint8Array | null> {
    while (this.buffered < n) {
      if (!(await this.pull())) {
        if (this.buffered === 0) return null;
        throw reject("T1", "the tar ends inside an entry");
      }
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const first = this.chunks[0] as Uint8Array;
      const take = Math.min(first.byteLength, n - at);
      out.set(first.subarray(0, take), at);
      at += take;
      if (take === first.byteLength) this.chunks.shift();
      else this.chunks[0] = first.subarray(take);
    }
    this.buffered -= n;
    return out;
  }

  async skip(n: number): Promise<void> {
    if (n > 0 && (await this.read(n)) === null) throw reject("T1", "the tar ends inside an entry");
  }
}

const field = (h: Uint8Array, offset: number, length: number): Uint8Array => {
  const raw = h.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return nul === -1 ? raw : raw.subarray(0, nul);
};

function octal(h: Uint8Array, offset: number, length: number): number {
  const raw = field(h, offset, length);
  if (raw.length > 0 && ((raw[0] as number) & 0x80) !== 0) throw reject("T1", "base-256 numbers are not accepted");
  const text = new TextDecoder().decode(raw).trim();
  if (!/^[0-7]*$/u.test(text)) throw reject("T1", "malformed tar header");
  return text === "" ? 0 : parseInt(text, 8);
}

function checksumOk(h: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
  return sum === octal(h, 148, 8);
}

function text(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw reject("T4", "an entry name is not UTF-8");
  }
}

/** Records of a pax extended header: "<len> <key>=<value>\n". */
function paxRecords(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) throw reject("T1", "malformed pax header");
    const len = Number(new TextDecoder().decode(data.subarray(at, space)));
    if (!Number.isInteger(len) || len <= 0 || at + len > data.length) throw reject("T1", "malformed pax header");
    const record = text(data.subarray(space + 1, at + len - 1));
    const eq = record.indexOf("=");
    if (eq === -1) throw reject("T1", "malformed pax header");
    out.set(record.slice(0, eq), record.slice(eq + 1));
    at += len;
  }
  return out;
}

export interface ExtractOptions {
  gzip: boolean;
  limits?: Partial<TarLimits>;
  now?: () => number;
}

function toStream(input: ReadableStream<Uint8Array> | Uint8Array): ReadableStream<Uint8Array> {
  if (!(input instanceof Uint8Array)) return input;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });
}

/** Extracts a tar (or gzip tar) into path -> bytes, applying T1-T8. Throws TarRejected or InputTooLarge. */
export async function extractTar(input: ReadableStream<Uint8Array> | Uint8Array, options: ExtractOptions): Promise<Map<string, Uint8Array>> {
  const limits = { ...UPLOAD_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  let compressed = 0;
  let decompressed = 0;
  const counted = toStream(input).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        compressed += chunk.byteLength;
        if (compressed > limits.maxInputBytes) throw new InputTooLarge("the body is over the upload limit");
        controller.enqueue(chunk);
      },
    }),
  );
  const tarStream = options.gzip ? counted.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>) : counted;
  const raw = tarStream.getReader();
  const bytes = new ByteReader(raw, now() + limits.timeoutMs, now, (n) => {
    if (!options.gzip) return;
    decompressed += n;
    if (decompressed >= limits.ratioAfterBytes && decompressed / Math.max(compressed, 1) > limits.maxRatio) {
      throw reject("T6", `the compression ratio is over ${limits.maxRatio}:1`);
    }
  });

  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  let entries = 0;
  let total = 0;
  let pax = new Map<string, string>();
  try {
    for (;;) {
      const header = await bytes.read(BLOCK);
      if (header === null || header.every((b) => b === 0)) break;
      if (!checksumOk(header)) throw reject("T1", "malformed tar header");
      const type = String.fromCharCode(header[156] as number);
      const size = pax.has("size") ? Number(pax.get("size")) : octal(header, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0) throw reject("T1", "malformed tar header");
      const padded = Math.ceil(size / BLOCK) * BLOCK;

      if (type === "x") {
        if (size > MAX_PAX_BYTES) throw reject("T1", "pax header too large");
        const data = (await bytes.read(padded)) ?? new Uint8Array(0);
        pax = paxRecords(data.subarray(0, size));
        continue;
      }
      let name = pax.get("path");
      if (name === undefined) {
        const prefix = text(field(header, 345, 155));
        const short = text(field(header, 0, 100));
        name = prefix === "" ? short : `${prefix}/${short}`;
      }
      pax = new Map();
      if (type !== "0" && type !== "\0" && type !== "5") {
        throw reject("T1", type === "1" || type === "2" ? "links are not accepted" : `entry type ${JSON.stringify(type)} is not accepted`, name);
      }

      entries++;
      if (entries > limits.maxEntries) throw reject("T3", `more than ${limits.maxEntries} entries`);
      let path = name.startsWith("./") ? name.slice(2) : name;
      if (type === "5" && path.endsWith("/")) path = path.slice(0, -1);
      if (path === "" || path === ".") {
        if (type === "5") continue;
        throw reject("T4", "an entry has an empty name");
      }
      const problem = pathProblem(path);
      if (problem !== null) throw reject("T4", problem, path);
      const parents = path.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"));
      if (files.has(path) || dirs.has(path) || parents.some((p) => files.has(p))) throw reject("T7", "the path appears twice", path);

      if (type === "5") {
        if (size !== 0) throw reject("T1", "a directory entry has a size", path);
        dirs.add(path);
        continue;
      }
      if (size > limits.maxEntryBytes) throw reject("T5", `the file is over ${limits.maxEntryBytes} bytes`, path);
      total += size;
      if (total > limits.maxTotalBytes) throw reject("T2", `the files total over ${limits.maxTotalBytes} bytes`);
      const data = size === 0 ? new Uint8Array(0) : await bytes.read(size);
      if (data === null) throw reject("T1", "the tar ends inside an entry", path);
      await bytes.skip(padded - size);
      files.set(path, data);
    }
  } catch (e) {
    await raw.cancel().catch(() => {});
    if (e instanceof TypeError && /gzip|inflate|decompress|zlib|header/iu.test(e.message)) throw reject("T1", "the body is not valid gzip");
    throw e;
  }
  return files;
}

const encoder = new TextEncoder();

function writeOctal(h: Uint8Array, offset: number, length: number, value: number): void {
  const s = value.toString(8).padStart(length - 1, "0");
  h.set(encoder.encode(s), offset);
  h[offset + length - 1] = 0;
}

function header(name: Uint8Array, size: number, type: "0" | "x"): Uint8Array {
  const h = new Uint8Array(BLOCK);
  h.set(name.subarray(0, 100), 0);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, 0);
  h[156] = type.charCodeAt(0);
  h.set(encoder.encode("ustar\0"), 257);
  h.set(encoder.encode("00"), 263);
  for (let i = 148; i < 156; i++) h[i] = 32;
  let sum = 0;
  for (const b of h) sum += b;
  h.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return h;
}

function paxRecord(key: string, value: string): Uint8Array {
  // The length prefix counts itself, so find the fixed point.
  const body = ` ${key}=${value}\n`;
  const n = encoder.encode(body).length;
  let len = n + 1;
  while (String(len).length + n !== len) len = String(len).length + n;
  return encoder.encode(`${len}${body}`);
}

const pad = (n: number): Uint8Array => new Uint8Array((BLOCK - (n % BLOCK)) % BLOCK);

/** A ustar archive of `files`, sorted by path, mode 0644, uid/gid/mtime 0; long or non-ASCII names in pax headers. */
export function writeTar(files: ReadonlyMap<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path) as Uint8Array;
    const name = encoder.encode(path);
    if (name.length > 100 || /[^\x20-\x7e]/u.test(path)) {
      const record = paxRecord("path", path);
      parts.push(header(encoder.encode(`PaxHeader/${path.slice(-80).replace(/[^\x20-\x7e]/gu, "_")}`), record.length, "x"), record, pad(record.length));
    }
    parts.push(header(name, data.length, "0"), data, pad(data.length));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
