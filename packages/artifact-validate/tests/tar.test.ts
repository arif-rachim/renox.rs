// Upload rules T1-T8 (docs/contracts/deploy-api.md section 4;
// docs/23-failure-modes.md "Tarball decompression bomb / too many files";
// docs/24-threat-model.md E, "Deploy API abuse (huge uploads, bombs)").
// The generated-bomb suite of #95 is tests/bombs.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTar, InputTooLarge, TarRejected, writeTar } from "../src/index.ts";

const enc = new TextEncoder();

/** One raw ustar header block (for entries writeTar never produces). */
function rawHeader(name: string, size: number, type: string, linkname = ""): Uint8Array {
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

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const block = (data: Uint8Array): Uint8Array => concat(data, new Uint8Array((512 - (data.length % 512)) % 512));
const END = new Uint8Array(1024);

async function rejected(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof TarRejected) return e.violation.rule;
    throw e;
  }
  throw new Error("not rejected");
}

describe("round trip", () => {
  test("writeTar then extractTar gives the same files, long and non-ASCII names included", async () => {
    const files = new Map<string, Uint8Array>([
      ["manifest.json", enc.encode("{}")],
      ["code/a.js", enc.encode("export const GET = 1;")],
      [`public/${"a-long-directory-name/".repeat(8)}x.txt`, enc.encode("deep")],
      ["public/café.txt", enc.encode("é")],
      ["code/empty.json", new Uint8Array(0)],
    ]);
    const tar = writeTar(files);
    expect(tar.length % 512).toBe(0);
    expect(await extractTar(tar, { gzip: false })).toEqual(files);
    const gz = Bun.gzipSync(tar);
    expect(await extractTar(gz, { gzip: true })).toEqual(files);
    expect(writeTar(files)).toEqual(tar);
  });

  test("a tar made by the system tar with ./ names is read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-tar-"));
    mkdirSync(join(dir, "src/code"), { recursive: true });
    writeFileSync(join(dir, "src/manifest.json"), "{}");
    writeFileSync(join(dir, "src/code/a.js"), "x");
    const out = join(dir, "a.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", out, "-C", join(dir, "src"), "."]).exitCode).toBe(0);
    const files = await extractTar(new Uint8Array(readFileSync(out)), { gzip: true });
    expect([...files.keys()].sort()).toEqual(["code/a.js", "manifest.json"]);
  });
});

describe("T rules", () => {
  test("T1: symbolic link, hard link, device, FIFO, global pax", async () => {
    for (const type of ["2", "1", "3", "4", "6", "g"]) {
      expect(await rejected(extractTar(concat(rawHeader("code/x", 0, type, "/etc/passwd"), END), { gzip: false }))).toBe("T1");
    }
  });

  test("T1: a symlink made by the system tar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-tar-"));
    mkdirSync(join(dir, "src"));
    symlinkSync("/etc/passwd", join(dir, "src/manifest.json"));
    const out = join(dir, "a.tar");
    Bun.spawnSync(["tar", "-cf", out, "-C", join(dir, "src"), "."]);
    expect(await rejected(extractTar(new Uint8Array(readFileSync(out)), { gzip: false }))).toBe("T1");
  });

  test("T1: a bad checksum, a truncated entry, not gzip", async () => {
    const h = rawHeader("code/a.js", 4, "0");
    h[0] = "x".charCodeAt(0);
    expect(await rejected(extractTar(concat(h, block(enc.encode("abcd")), END), { gzip: false }))).toBe("T1");
    expect(await rejected(extractTar(concat(rawHeader("code/a.js", 4000, "0"), enc.encode("ab")), { gzip: false }))).toBe("T1");
    expect(await rejected(extractTar(enc.encode("not gzip at all"), { gzip: true }))).toBe("T1");
  });

  test("T2: total size", async () => {
    const files = new Map([
      ["a", new Uint8Array(600)],
      ["b", new Uint8Array(600)],
    ]);
    expect(await rejected(extractTar(writeTar(files), { gzip: false, limits: { maxTotalBytes: 1000 } }))).toBe("T2");
  });

  test("T3: entry count", async () => {
    const files = new Map(Array.from({ length: 11 }, (_, i) => [`code/${i}.js`, new Uint8Array(1)] as const));
    expect(await rejected(extractTar(writeTar(files), { gzip: false, limits: { maxEntries: 10 } }))).toBe("T3");
  });

  test("T4: path escape, absolute path, too many segments", async () => {
    for (const name of ["code/../../etc/passwd", "/etc/passwd", "a\\b", `${"a/".repeat(33)}x`]) {
      const bytes = concat(rawHeader(name.length > 100 ? "x" : name, 1, "0"), block(enc.encode("x")), END);
      if (name.length > 100) continue;
      expect(await rejected(extractTar(bytes, { gzip: false })), name).toBe("T4");
    }
    const deep = new Map([[`${"a/".repeat(33)}x`, new Uint8Array(1)]]);
    expect(await rejected(extractTar(writeTar(deep), { gzip: false }))).toBe("T4");
  });

  test("T5: one oversized entry, refused before its bytes are read", async () => {
    let pulled = 0;
    const header = rawHeader("code/big.js", 30 * 1024 * 1024, "0");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 0) controller.enqueue(header);
        else controller.enqueue(new Uint8Array(64 * 1024));
        pulled++;
      },
    });
    expect(await rejected(extractTar(stream, { gzip: false }))).toBe("T5");
    expect(pulled).toBeLessThan(20);
  });

  test("T6: a high-ratio gzip bomb stops early", async () => {
    const bomb = Bun.gzipSync(writeTar(new Map([["code/zero.js", new Uint8Array(15 * 1024 * 1024)]])));
    expect(bomb.length).toBeLessThan(100_000);
    expect(await rejected(extractTar(bomb, { gzip: true }))).toBe("T6");
  });

  test("T7: the same path twice, a file under a file", async () => {
    const twice = concat(rawHeader("code/a.js", 1, "0"), block(enc.encode("x")), rawHeader("code/a.js", 1, "0"), block(enc.encode("y")), END);
    expect(await rejected(extractTar(twice, { gzip: false }))).toBe("T7");
    const under = concat(rawHeader("code", 1, "0"), block(enc.encode("x")), rawHeader("code/a.js", 1, "0"), block(enc.encode("y")), END);
    expect(await rejected(extractTar(under, { gzip: false }))).toBe("T7");
  });

  test("T8: a body that stalls past the time limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(rawHeader("code/a.js", 1024, "0"));
      },
    });
    const started = Date.now();
    expect(await rejected(extractTar(stream, { gzip: false, limits: { timeoutMs: 200 } }))).toBe("T8");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the input cap throws InputTooLarge", async () => {
    const tar = writeTar(new Map([["code/a.js", new Uint8Array(4096)]]));
    await expect(extractTar(tar, { gzip: false, limits: { maxInputBytes: 1000 } })).rejects.toBeInstanceOf(InputTooLarge);
  });
});
