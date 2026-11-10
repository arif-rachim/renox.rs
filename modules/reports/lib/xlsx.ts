// A minimal Excel writer and reader in TypeScript (#333; no dependency, B17):
// one worksheet of strings and numbers as an OOXML package, zipped with the
// stored method (no compression) so nothing but CRC-32 is needed. The reader
// (#724) opens what the writer makes and what Excel or LibreOffice save
// (deflate, shared strings), with a small inflate of its own.

const enc = new TextEncoder();
const dec = new TextDecoder();

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const xml = (s: string): string => s.replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "");

function column(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export type Cell = string | number | null;

/** A workbook with one sheet named `sheet`; numbers stay numbers, strings are inline (never formulas). */
export function xlsx(sheet: string, rows: readonly (readonly Cell[])[]): Uint8Array {
  const body = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = `${column(ci)}${ri + 1}`;
      if (v === null) return "";
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
    }).join("")}</row>`)
    .join("");
  const files: [string, string][] = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`],
  ];
  return zip(files.map(([n, t]) => [n, enc.encode(t)]));
}

function zip(entries: [string, Uint8Array][]): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  const u16 = (n: number) => [n & 255, (n >> 8) & 255];
  const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const [name, data] of entries) {
    const n = enc.encode(name);
    const offset = parts.length;
    const crc = crc32(data);
    // Local header: version 20, no flags, stored, a fixed DOS time (1980-01-01).
    parts.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(n.length), ...u16(0), ...n);
    for (let k = 0; k < data.length; k++) parts.push(data[k] as number); // no spread: a big sheet would overflow the stack
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...n);
  }
  const cdOffset = parts.length;
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(cdOffset), ...u16(0)];
  const out = new Uint8Array(parts.length + central.length + end.length);
  out.set(parts);
  out.set(central, parts.length);
  out.set(end, parts.length + central.length);
  return out;
}

const MAX_ENTRY = 64 * 1024 * 1024;

/** Raw DEFLATE (RFC 1951), after puff.c; `limit` bounds the output so a bomb stops early. */
function inflate(src: Uint8Array, limit: number): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.min(Math.max(src.length * 4, 1024), limit));
  let n = 0;
  const bits = (need: number): number => {
    let v = bitBuf;
    while (bitCnt < need) {
      if (pos >= src.length) throw new Error("deflate: out of input");
      v |= (src[pos++] as number) << bitCnt;
      bitCnt += 8;
    }
    bitBuf = v >>> need;
    bitCnt -= need;
    return v & ((1 << need) - 1);
  };
  const put = (b: number): void => {
    if (n >= limit) throw new Error("deflate: output too large");
    if (n === out.length) {
      const bigger = new Uint8Array(Math.min(out.length * 2, limit));
      bigger.set(out);
      out = bigger;
    }
    out[n++] = b;
  };
  type Huff = { count: number[]; symbol: number[] };
  const build = (lengths: number[]): Huff => {
    const count = new Array<number>(16).fill(0);
    for (const l of lengths) count[l] = (count[l] as number) + 1;
    const offs = new Array<number>(16).fill(0);
    for (let i = 1; i < 15; i++) offs[i + 1] = (offs[i] as number) + (count[i] as number);
    const symbol = new Array<number>(lengths.length).fill(0);
    lengths.forEach((l, sym) => {
      if (l !== 0) symbol[offs[l]++] = sym;
    });
    return { count, symbol };
  };
  const decode = (h: Huff): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const c = h.count[len] as number;
      if (code - c < first) return h.symbol[index + (code - first)] as number;
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("deflate: bad code");
  };
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const codes = (lit: Huff, dist: Huff): void => {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) put(sym);
      else if (sym === 256) return;
      else {
        sym -= 257;
        if (sym >= 29) throw new Error("deflate: bad length");
        const len = (LBASE[sym] as number) + bits(LEXT[sym] as number);
        const ds = decode(dist);
        if (ds >= 30) throw new Error("deflate: bad distance");
        const d = (DBASE[ds] as number) + bits(DEXT[ds] as number);
        if (d > n) throw new Error("deflate: distance too far");
        for (let k = 0; k < len; k++) put(out[n - d] as number);
      }
    }
  };
  let fixed: [Huff, Huff] | undefined;
  for (let last = 0; last === 0; ) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new Error("deflate: out of input");
      const len = (src[pos] as number) | ((src[pos + 1] as number) << 8);
      if (((src[pos + 2] as number) | ((src[pos + 3] as number) << 8)) !== (~len & 0xffff)) throw new Error("deflate: bad stored block");
      pos += 4;
      if (pos + len > src.length) throw new Error("deflate: out of input");
      for (let k = 0; k < len; k++) put(src[pos++] as number);
    } else if (type === 1) {
      if (fixed === undefined) {
        const l = new Array<number>(288).fill(8);
        for (let i = 144; i < 256; i++) l[i] = 9;
        for (let i = 256; i < 280; i++) l[i] = 7;
        fixed = [build(l), build(new Array<number>(30).fill(5))];
      }
      codes(fixed[0], fixed[1]);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw new Error("deflate: bad counts");
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const cl = new Array<number>(19).fill(0);
      for (let i = 0; i < ncode; i++) cl[order[i] as number] = bits(3);
      const clh = build(cl);
      const lengths: number[] = [];
      while (lengths.length < nlen + ndist) {
        const sym = decode(clh);
        if (sym < 16) lengths.push(sym);
        else {
          let rep: number;
          let val = 0;
          if (sym === 16) {
            if (lengths.length === 0) throw new Error("deflate: bad repeat");
            val = lengths[lengths.length - 1] as number;
            rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (lengths.length + rep > nlen + ndist) throw new Error("deflate: bad repeat");
          for (let k = 0; k < rep; k++) lengths.push(val);
        }
      }
      codes(build(lengths.slice(0, nlen)), build(lengths.slice(nlen)));
    } else throw new Error("deflate: bad block type");
  }
  return out.subarray(0, n);
}

/** The files of a zip package, read from the central directory (so Excel's and LibreOffice's deflated entries with data descriptors work, as do the writer's stored ones). */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let p = bytes.length - 22; p >= 0 && p >= bytes.length - 22 - 0xffff; p--) {
    if (view.getUint32(p, true) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (usize > MAX_ENTRY) throw new Error(`${name}: too large`);
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + csize > bytes.length) throw new Error(`${name}: truncated`);
    const raw = bytes.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = inflate(raw, Math.max(usize, 1));
    else throw new Error(`${name}: unsupported method ${method}`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    files.set(name, data);
  }
  return files;
}

const unxml = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/giu, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/gu, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");

/** The text of the `<t>` runs of a shared or inline string (phonetic runs left out). */
const runs = (s: string): string => [...s.replace(/<rPh\b.*?<\/rPh>/gsu, "").matchAll(/<t\b[^>]*?(?:\/>|>(.*?)<\/t>)/gsu)].map((t) => unxml(t[1] ?? "")).join("");

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`, "u").exec(tag)?.[1];

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** The rows of the first sheet of an .xlsx (the writer's, Excel's or LibreOffice's): shared and inline strings, a formula's cached value, a gap as null, trailing empty rows dropped (a short row stays short: the service pads it). */
export function readXlsx(bytes: Uint8Array): Cell[][] {
  const files = unzip(bytes);
  const text = (name: string): string | undefined => {
    const f = files.get(name);
    return f === undefined ? undefined : dec.decode(f);
  };
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  const first = workbook === undefined ? undefined : /<sheet\b[^>]*>/u.exec(workbook)?.[0];
  const rid = first === undefined ? undefined : (/\br:id="([^"]*)"/u.exec(first)?.[1] ?? attr(first, "id"));
  if (rid !== undefined && rels !== undefined) {
    for (const r of rels.matchAll(/<Relationship\b[^>]*>/gu)) {
      if (attr(r[0], "Id") === rid) {
        const target = attr(r[0], "Target");
        if (target !== undefined) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      }
    }
  }
  const sheet = text(sheetPath);
  if (sheet === undefined) throw new Error("no first sheet");
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*?(?:\/>|>(.*?)<\/si>)/gsu)].map((m) => runs(m[1] ?? ""));
  const rows: Cell[][] = [];
  let rowNo = 0;
  for (const m of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>(.*?)<\/row>)/gsu)) {
    const declared = attr(m[1] as string, "r");
    rowNo = declared !== undefined ? Number(declared) : rowNo + 1;
    if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > 1_048_576) throw new Error("bad row number");
    const row: Cell[] = [];
    let col = -1;
    for (const c of (m[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>(.*?)<\/c>)/gsu)) {
      const tag = c[1] as string;
      const ref = attr(tag, "r");
      col = ref !== undefined ? columnIndex(ref) : col + 1;
      if (col < 0 || col > 16_383) throw new Error("bad cell reference");
      const type = attr(tag, "t");
      const inner = c[2] ?? "";
      const v = /<v\b[^>]*?(?:\/>|>(.*?)<\/v>)/su.exec(inner)?.[1];
      let cell: Cell = null;
      if (type === "inlineStr") cell = runs(/<is\b[^>]*>(.*?)<\/is>/su.exec(inner)?.[1] ?? "");
      else if (v !== undefined && v !== "") {
        if (type === "s") cell = shared[Number(v)] ?? null;
        else if (type === "str" || type === "d") cell = unxml(v);
        else if (type === "e") cell = null;
        else {
          const num = Number(v);
          cell = Number.isFinite(num) ? num : null;
        }
      }
      while (row.length < col) row.push(null);
      row[col] = cell;
    }
    while (rows.length < rowNo - 1) rows.push([]);
    rows[rowNo - 1] = row;
  }
  while (rows.length > 0 && (rows[rows.length - 1] as Cell[]).every((v) => v === null)) rows.pop();
  return rows;
}
