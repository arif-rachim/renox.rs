// Test only: stores a 64 x 48 PNG in the signed-in user's folder through the service.
import { auth, storage } from "renox:modules";

// A 64 x 48 solid PNG (zlib-compressed rows), built once.
function png(): Uint8Array {
  const w = 64, h = 48;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: Uint8Array) => { const t = new TextEncoder().encode(type); const body = new Uint8Array([...t, ...data]); return [...be(data.length), ...body, ...be(crc(body))]; };
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([200, 30, 30], y * (1 + w * 3) + 1 + x * 3);
  // zlib stored blocks (no compression), so no compressor is needed.
  const blocks: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.subarray(i, Math.min(i + 65535, raw.length));
    const last = i + 65535 >= raw.length ? 1 : 0;
    blocks.push(last, part.length & 255, part.length >> 8, ~part.length & 255, (~part.length >> 8) & 255, ...part);
  }
  let a = 1, b = 0;
  for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  blocks.push(...be(((b << 16) | a) >>> 0));
  const ihdr = new Uint8Array([...be(w), ...be(h), 8, 2, 0, 0, 0]);
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", ihdr), ...chunk("IDAT", new Uint8Array(blocks)), ...chunk("IEND", new Uint8Array())]);
}

export async function POST() {
  const user = await auth.requireUser();
  const f = await storage.upload(user.id.toLowerCase(), "chair.png", png(), "image/png", { public: true });
  return Response.json(f);
}
