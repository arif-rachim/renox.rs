// Writes public/icons/icon-192.png and icon-512.png: solid squares in the
// seeded brand colour (seeds/001_demo.sql, brand_color), no text. Run once with
// `bun scripts/make-icons.ts`; the PNGs are committed. A script for the
// developer's machine (it uses zlib), not part of the app. The chunk writer is
// the one of examples/shop/lib/placeholder-png.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const BRAND: [number, number, number] = [0x1f, 0x6f, 0x5c];

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (out: Uint8Array, at: number, n: number) => {
  out[at] = (n >>> 24) & 0xff;
  out[at + 1] = (n >>> 16) & 0xff;
  out[at + 2] = (n >>> 8) & 0xff;
  out[at + 3] = n & 0xff;
};

/** A PNG chunk: length, type, data, CRC of type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  u32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  u32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A `size` x `size` one-colour image: 8-bit palette, one entry, deflated rows. */
function solidPng(rgb: [number, number, number], size: number): Uint8Array {
  const raw = new Uint8Array(size * (size + 1)); // filter byte 0, then palette index 0
  const ihdr = new Uint8Array(13);
  u32(ihdr, 0, size);
  u32(ihdr, 4, size);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", new Uint8Array(rgb)),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return bytes;
}

const dir = fileURLToPath(new URL("../public/icons/", import.meta.url));
mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) writeFileSync(`${dir}icon-${size}.png`, solidPng(BRAND, size));
