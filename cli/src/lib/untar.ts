// A minimal, strict tar reader for the exports (docs/contracts/deploy-api.md
// section 14, "Tar format of `files`"). Regular files only; every entry is
// checked before anything is written, so a refused archive leaves nothing.
//
// Supported name forms: ustar `prefix` + `name`, a PAX `x` header with `path`
// (the CLI's own packer emits it for names over 100 bytes), and a GNU `L`
// long-name entry. Anything else (links, devices, PAX global headers, ...) is
// refused.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { EnvironmentError } from "../errors.ts";

const BLOCK = 512;
const dec = new TextDecoder();

export interface UntarOptions {
  /** Every entry name must start with this (and have something after it); "" allows any relative name. */
  allowPrefix: string;
  /** A directory entry: `refuse` (default, the files tar has none) or `skip` (the artifact tar may have them). */
  dirs?: "refuse" | "skip";
}

const bad = (why: string): EnvironmentError => new EnvironmentError(`the archive is refused: ${why}`, { hint: "nothing was kept; run the command again, and report it if it repeats" });

function cstr(h: Uint8Array, at: number, len: number): string {
  const end = h.subarray(at, at + len).indexOf(0);
  return dec.decode(h.subarray(at, end < 0 ? at + len : at + end));
}

function octal(h: Uint8Array, at: number, len: number): number {
  const s = cstr(h, at, len).trim();
  if (!/^[0-7]+$/u.test(s)) throw bad("malformed header");
  return Number.parseInt(s, 8);
}

function paxPath(data: Uint8Array): string | undefined {
  let at = 0;
  let path: string | undefined;
  while (at < data.length) {
    const sp = data.indexOf(32, at);
    const len = Number(dec.decode(data.subarray(at, sp < 0 ? at : sp)));
    if (sp < 0 || !Number.isInteger(len) || len <= sp - at + 1 || at + len > data.length) throw bad("malformed pax header");
    const rec = dec.decode(data.subarray(sp + 1, at + len - 1));
    const eq = rec.indexOf("=");
    const key = rec.slice(0, eq);
    if (key === "path") path = rec.slice(eq + 1);
    else if (key === "size" || key === "linkpath") throw bad(`pax key ${key} is not accepted`);
    at += len;
  }
  return path;
}

function nameProblem(name: string, allowPrefix: string): string | null {
  if (name.includes("\0")) return "a name holds a NUL byte";
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name) || name.includes("\\")) return `${JSON.stringify(name)} is not a relative POSIX name`;
  if (name.split("/").some((s) => s === ".." || s === "." || s === "")) return `${JSON.stringify(name)} has an empty, "." or ".." segment`;
  if (!name.startsWith(allowPrefix) || name.length === allowPrefix.length) return `${JSON.stringify(name)} is outside ${JSON.stringify(allowPrefix)}`;
  return null;
}

/** Unpacks the gzip tar `file` into `dest`; returns the number of files written. Throws EnvironmentError (exit 3) on a refused entry. */
export async function untarGz(file: string, dest: string, opts: UntarOptions): Promise<number> {
  let tar: Uint8Array;
  try {
    tar = Bun.gunzipSync(new Uint8Array(readFileSync(file)));
  } catch (err) {
    throw bad(`not a gzip file (${(err as Error).message})`);
  }
  const entries: { name: string; data: Uint8Array }[] = [];
  let at = 0;
  let longName: string | undefined;
  let pax: string | undefined;
  for (;;) {
    if (at + BLOCK > tar.length) throw bad("the archive ends before its end marker");
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
    if (sum !== octal(h, 148, 8)) throw bad("a header checksum is wrong");
    const type = String.fromCharCode(h[156] as number);
    const size = octal(h, 124, 12);
    const body = at + BLOCK;
    if (body + size > tar.length) throw bad("an entry is cut short");
    const data = tar.subarray(body, body + size);
    at = body + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pax = paxPath(data);
      continue;
    }
    if (type === "L") {
      longName = cstr(data, 0, data.length);
      continue;
    }
    const prefix = cstr(h, 345, 155);
    const short = cstr(h, 0, 100);
    const name = pax ?? longName ?? (prefix === "" ? short : `${prefix}/${short}`);
    pax = undefined;
    longName = undefined;
    if (type === "5") {
      if (opts.dirs === "skip") continue;
      throw bad(`${JSON.stringify(name)} is a directory`);
    }
    if (type !== "0" && type !== "\0") throw bad(`${JSON.stringify(name)} is not a regular file (type ${JSON.stringify(type)})`);
    const problem = nameProblem(name, opts.allowPrefix);
    if (problem !== null) throw bad(problem);
    entries.push({ name, data });
  }
  const root = resolve(dest);
  const targets = entries.map((e) => {
    const target = resolve(root, e.name);
    if (!target.startsWith(root + sep)) throw bad(`${JSON.stringify(e.name)} leaves the destination`);
    return target;
  });
  mkdirSync(root, { recursive: true });
  entries.forEach((e, i) => {
    mkdirSync(dirname(targets[i] as string), { recursive: true });
    writeFileSync(targets[i] as string, e.data);
  });
  return entries.length;
}
