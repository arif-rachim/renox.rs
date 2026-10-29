// A QR code (ISO/IEC 18004) for the TOTP enrolment page (#287): byte mode,
// error correction level M, versions 1 to 15 (up to 412 bytes, enough for
// any otpauth:// URI), the mask with the lowest penalty, drawn as an inline
// SVG so the page needs no image and no script. After the reference
// algorithm of Nayuki's "QR Code generator library" (MIT).

/** ECC level M: [ec codewords per block, blocks in group 1, data per block in group 1, blocks in group 2]. */
const ECC_M: readonly (readonly [number, number, number, number])[] = [
  [10, 1, 16, 0], [16, 1, 28, 0], [26, 1, 44, 0], [18, 2, 32, 0], [24, 2, 43, 0],
  [16, 4, 27, 0], [18, 4, 31, 0], [22, 2, 38, 2], [22, 3, 36, 2], [26, 4, 43, 1],
  [30, 1, 50, 4], [22, 6, 36, 2], [22, 8, 37, 1], [24, 4, 40, 5], [24, 5, 41, 5],
];

const ALIGN: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
];

export const MAX_VERSION = ECC_M.length;

function dataCapacity(version: number): number {
  const [, b1, d1, b2] = ECC_M[version - 1] as readonly [number, number, number, number];
  return b1 * d1 + b2 * (d1 + 1);
}

// GF(2^8) with the polynomial 0x11D.
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j] as number, root);
      if (j + 1 < result.length) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] = (result[i] as number) ^ gfMul(coef, factor)));
  }
  return result;
}

/** The final codeword sequence: data blocks with their error correction, interleaved. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCapacity(version);
  const countBits = version < 10 ? 8 : 16;
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const [ec, b1, d1, b2] = ECC_M[version - 1] as readonly [number, number, number, number];
  const divisor = rsDivisor(ec);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let k = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d1 + 1;
    const d = data.slice(k, k + len);
    k += len;
    blocks.push({ data: d, ec: rsRemainder(d, divisor) });
  }
  const out: number[] = [];
  for (let i = 0; i <= d1; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i] as number);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i] as number);
  return out;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    (this.dark[y] as boolean[])[x] = dark;
    (this.fixed[y] as boolean[])[x] = true;
  }

  drawFunctionPatterns(): void {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= s || y < 0 || y >= s) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = ALIGN[this.version - 1] as readonly number[];
    pos.forEach((x, i) =>
      pos.forEach((y, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }),
    );
    this.drawFormat(0);
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) !== 0;
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit);
        this.set(b, a, bit);
      }
    }
  }

  drawFormat(mask: number): void {
    const data = (0b00 << 3) | mask; // level M
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true);
  }

  drawCodewords(data: readonly number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!(this.fixed[y] as boolean[])[x] && i < data.length * 8) {
            (this.dark[y] as boolean[])[x] = (((data[i >>> 3] as number) >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    const f = MASKS[mask] as (x: number, y: number) => boolean;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!(this.fixed[y] as boolean[])[x] && f(x, y)) (this.dark[y] as boolean[])[x] = !(this.dark[y] as boolean[])[x];
      }
    }
  }

  /** The penalty of ISO/IEC 18004 section 7.8.3 (N1 = 3, N2 = 3, N3 = 40, N4 = 10); no allocation per cell. */
  penalty(): number {
    const s = this.size;
    const d = this.dark;
    let p = 0;
    // 1:1:3:1:1 with four light modules on either side (outside the symbol counts as light).
    const finder = (get: (i: number) => boolean, i: number): boolean => {
      const at = (k: number) => k >= 0 && k < s && get(k);
      if (!(at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6))) return false;
      const lightBefore = !at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4);
      const lightAfter = !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10);
      return lightBefore || lightAfter;
    };
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i <= s; i++) {
        if (i < s && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) p += 3 + (run - 5);
          run = 1;
        }
      }
      for (let i = 0; i + 6 < s; i++) if (finder(get, i)) p += 40;
    };
    for (let y = 0; y < s; y++) {
      const row = d[y] as boolean[];
      line((x) => row[x] as boolean);
    }
    for (let x = 0; x < s; x++) line((y) => (d[y] as boolean[])[x] as boolean);
    let dark = 0;
    for (let y = 0; y < s; y++) {
      const r0 = d[y] as boolean[];
      const r1 = d[y + 1];
      for (let x = 0; x < s; x++) {
        if (r0[x]) dark++;
        if (r1 !== undefined && x + 1 < s && r0[x] === r0[x + 1] && r0[x] === r1[x] && r0[x] === r1[x + 1]) p += 3;
      }
    }
    const k = Math.ceil(Math.abs(dark * 20 - s * s * 10) / (s * s)) - 1;
    return p + k * 10;
  }
}

/** The module matrix (true = dark) of `text`; `mask` forces a mask (tests), else the lowest penalty wins. */
export function qrMatrix(text: string, mask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= MAX_VERSION && dataCapacity(version) * 8 < 4 + (version < 10 ? 8 : 16) + bytes.length * 8) version++;
  if (version > MAX_VERSION) throw new RangeError(`qr: at most ${dataCapacity(MAX_VERSION) - 3} bytes`);
  const data = codewords(bytes, version);
  const base = new Grid(version);
  base.drawFunctionPatterns();
  base.drawCodewords(data);
  const at = (m: number) => {
    const g = new Grid(version);
    g.drawFunctionPatterns();
    g.dark.forEach((row, y) => row.forEach((_, x) => ((g.dark[y] as boolean[])[x] = (base.dark[y] as boolean[])[x] as boolean)));
    g.applyMask(m);
    g.drawFormat(m);
    return g;
  };
  if (mask !== undefined) return at(mask).dark;
  let best = at(0);
  let bestPenalty = best.penalty();
  for (let m = 1; m < 8; m++) {
    const g = at(m);
    const p = g.penalty();
    if (p < bestPenalty) {
      best = g;
      bestPenalty = p;
    }
  }
  return best.dark;
}

/** An SVG of `text` as a QR code: one path, a 4-module quiet zone, `size` pixels square. */
export function qrSvg(text: string, size = 200): string {
  const m = qrMatrix(text);
  const n = m.length + 8;
  // One rectangle per horizontal run of dark modules.
  const parts: string[] = [];
  m.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end++;
      parts.push(`M${x + 4} ${y + 4}h${end - x + 1}v1h-${end - x + 1}z`);
      x = end;
    }
  });
  const d = parts.join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
