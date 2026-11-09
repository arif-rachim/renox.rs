// A one-sheet Excel (.xlsx) file for the app's own reports. The `reports` module
// writes .xlsx for its sales and cash exports but offers no service for it (its
// services are `sales`, `csv`, `accounting`, `cash` and `nightly`), so an app
// report cannot ask it for one: this is a separate, small writer. The package is
// zipped with the stored method (no compression), so only CRC-32 is needed.
// Strings are inline text, never formulas; numbers stay numbers.

export type Cell = string | number;

const enc = new TextEncoder();

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Text safe inside an XML element or attribute (control characters dropped). */
const escapeXml = (s: string): string =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "")
    .replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** `A`, `B`, ... `Z`, `AA` for a zero-based column. */
function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function sheetXml(rows: readonly (readonly Cell[])[]): string {
  const data = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `${XML}<worksheet xmlns="${MAIN}"><sheetData>${data}</sheetData></worksheet>`;
}

/** A workbook with one sheet called `sheet` holding `rows` (the first row is usually the header). */
export function xlsx(sheet: string, rows: readonly (readonly Cell[])[]): Uint8Array {
  const parts: [string, string][] = [
    ["[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ["_rels/.rels", `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="${escapeXml(sheet.replace(/[\\/?*[\]:]/gu, " ").slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", sheetXml(rows)],
  ];
  return zip(parts.map(([name, text]) => [name, enc.encode(text)]));
}

const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

/** A zip archive of stored (uncompressed) entries. */
function zip(entries: readonly [string, Uint8Array][]): Uint8Array {
  const out: number[] = [];
  const directory: number[] = [];
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name);
    const offset = out.length;
    const crc = crc32(data);
    // Version 20, no flags, method 0 (stored), the DOS time 00:00:00 and date 1980-01-01.
    out.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...nameBytes);
    for (const b of data) out.push(b);
    directory.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes);
  }
  const start = out.length;
  for (const b of directory) out.push(b);
  out.push(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(directory.length), ...u32(start), ...u16(0));
  return Uint8Array.from(out);
}
