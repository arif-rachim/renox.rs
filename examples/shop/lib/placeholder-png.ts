// The shop's product images (#332): one 400 × 400 PNG per category, made in
// the isolate (no image files in the repository, no zlib): a two-colour
// palette image with diagonal stripes, deflate in stored blocks.

const SIZE = 400;

/** Background and stripe colours per category; anything else is grey. */
export const COLOURS: Record<string, [number, number, number][]> = {
  dates: [[0x8b, 0x5a, 0x2b], [0xc6, 0x8e, 0x4f]],
  coffee: [[0x4b, 0x2e, 0x1f], [0x8a, 0x5c, 0x3c]],
  spices: [[0xb3, 0x3a, 0x1b], [0xe0, 0x7a, 0x3f]],
  sweets: [[0xd9, 0xa4, 0x41], [0xf2, 0xd0, 0x8a]],
  perfume: [[0x5b, 0x3a, 0x7a], [0x9c, 0x7b, 0xb8]],
};

/** The CRC-32 table, built once when the module loads (read only after). */
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
  const t = TABLE;
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (t[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  // The modulo every 5552 bytes, as zlib does: the sums cannot overflow before it.
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Writes `n` big-endian at `at`. */
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

/** zlib with stored (uncompressed) deflate blocks of at most 65535 bytes. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let b = 0; b < blocks; b++) {
    const part = raw.subarray(b * 65535, Math.min(raw.length, (b + 1) * 65535));
    out[at] = b === blocks - 1 ? 1 : 0;
    out[at + 1] = part.length & 0xff;
    out[at + 2] = part.length >>> 8;
    out[at + 3] = ~part.length & 0xff;
    out[at + 4] = (~part.length >>> 8) & 0xff;
    out.set(part, at + 5);
    at += 5 + part.length;
  }
  u32(out, at, adler32(raw));
  return out;
}

/** The category's image: `SIZE` × `SIZE`, 8-bit palette, two colours. */
export function categoryPng(category: string): { bytes: Uint8Array; width: number; height: number } {
  const [bg, fg] = COLOURS[category] ?? [[0x88, 0x88, 0x88], [0xbb, 0xbb, 0xbb]];
  const raw = new Uint8Array(SIZE * (SIZE + 1));
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE + 1);
    for (let x = 0; x < SIZE; x++) raw[row + 1 + x] = Math.floor((x + y) / 40) % 2;
  }
  const ihdr = new Uint8Array(13);
  u32(ihdr, 0, SIZE);
  u32(ihdr, 4, SIZE);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", new Uint8Array([...(bg as number[]), ...(fg as number[])])),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, width: SIZE, height: SIZE };
}
