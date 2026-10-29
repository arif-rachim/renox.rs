// The small TOML writer the module commands need: inline values for
// renox.lock entries and one-line edits of renox.toml [modules], keeping the
// rest of the file (and its comments) as written. Bun only parses TOML.

import type { Json } from "../schema.ts";
import { isObject } from "../schema.ts";

const BARE = /^[A-Za-z0-9_-]+$/u;

export const tomlKey = (k: string): string => (BARE.test(k) ? k : JSON.stringify(k));

/** One TOML value on one line: strings as JSON strings (a TOML basic string), inline tables and arrays. */
export function tomlValue(v: Json): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`not an integer: ${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (isObject(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== null);
    return entries.length === 0 ? "{}" : `{ ${entries.map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x as Json)}`).join(", ")} }`;
  }
  throw new Error("null has no TOML form");
}

/** Index of the `[table]` header line, or -1. */
function headerIndex(lines: string[], table: string): number {
  return lines.findIndex((l) => new RegExp(`^\\s*\\[\\s*${table}\\s*\\]\\s*(#.*)?$`, "u").test(l));
}

/** End (exclusive) of the table starting at header `h`: the next header or the end of the file. */
function tableEnd(lines: string[], h: number): number {
  for (let i = h + 1; i < lines.length; i++) if (/^\s*\[/u.test(lines[i] as string)) return i;
  return lines.length;
}

const keyLine = (key: string): RegExp => new RegExp(`^\\s*["']?${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["']?\\s*=`, "u");

/** Sets `key = value` in `[table]` (replacing a one-line entry), creating the table at the end if needed. */
export function setTableEntry(text: string, table: string, key: string, value: Json): string {
  const lines = text.replace(/\n$/u, "").split("\n");
  const line = `${tomlKey(key)} = ${tomlValue(value)}`;
  let h = headerIndex(lines, table);
  if (h === -1) {
    if (lines.length > 0 && (lines[lines.length - 1] as string).trim() !== "") lines.push("");
    lines.push(`[${table}]`);
    h = lines.length - 1;
  }
  const end = tableEnd(lines, h);
  const at = lines.slice(h + 1, end).findIndex((l) => keyLine(key).test(l));
  if (at >= 0) lines[h + 1 + at] = line;
  else {
    // After the table's last non-blank line.
    let i = end;
    while (i > h + 1 && (lines[i - 1] as string).trim() === "") i--;
    lines.splice(i, 0, line);
  }
  return `${lines.join("\n")}\n`;
}

/** Removes the one-line `key = ...` entry of `[table]`; the text unchanged when there is none. */
export function removeTableEntry(text: string, table: string, key: string): string {
  const lines = text.replace(/\n$/u, "").split("\n");
  const h = headerIndex(lines, table);
  if (h === -1) return text;
  const end = tableEnd(lines, h);
  const at = lines.slice(h + 1, end).findIndex((l) => keyLine(key).test(l));
  if (at < 0) return text;
  lines.splice(h + 1 + at, 1);
  return `${lines.join("\n")}\n`;
}
