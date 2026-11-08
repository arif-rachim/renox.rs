// A tiny solid-colour PNG, made in the isolate (no image files in the
// repository, no zlib: the deflate stream is one stored block). The seed's
// visit photos and the tests' uploads use it; this is not the shop's generator,
// only what a visit needs: a small valid image of a given colour and size.

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
  for (const b of bytes) c = (TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (out: Uint8Array, at: number, n: number): void => {
  out[at] = (n >>> 24) & 0xff;
  out[at + 1] = (n >>> 16) & 0xff;
  out[at + 2] = (n >>> 8) & 0xff;
  out[at + 3] = n & 0xff;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  u32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  u32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A `size` x `size` RGB PNG of one colour (size 1 to 200). */
export function solidPng(rgb: [number, number, number], size = 8): { bytes: Uint8Array; width: number; height: number } {
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) raw.set(rgb, row + 1 + x * 3);
  }
  // zlib: header, one stored block (at most 65535 bytes), the Adler-32 of the data.
  const z = new Uint8Array(2 + 5 + raw.length + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  z[2] = 0x01;
  z[3] = raw.length & 0xff;
  z[4] = raw.length >>> 8;
  z[5] = ~raw.length & 0xff;
  z[6] = (~raw.length >>> 8) & 0xff;
  z.set(raw, 7);
  u32(z, 7 + raw.length, adler32(raw));
  const head = new Uint8Array(13);
  u32(head, 0, size);
  u32(head, 4, size);
  head[8] = 8; // bit depth
  head[9] = 2; // truecolour
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, width: size, height: size };
}

/** The base64 of `bytes`, for a `data:` URL. */
export function base64Of(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
