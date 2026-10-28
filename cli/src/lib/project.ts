// renox.toml: read and validate. Every problem is a ConfigError naming
// renox.toml, the line when it can be found, and what to do
// (docs/23-failure-modes.md section 3, "missing renox.toml").

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT, type ExitCode, CliError, type Where } from "../errors.ts";
import { type Json, isObject, validate } from "./schema.ts";
import { renoxTomlSchema } from "./schemas.ts";

export interface ProjectConfig {
  app: { name: string; timezone: string };
  permissions: { network: string[]; secrets: string[] };
  limits?: { cpu_ms?: number; wall_ms?: number; memory_mb?: number; concurrency?: number };
}

/** A renox.toml problem: exit 2, except a missing file (exit 1: not in an app folder). */
export class ConfigError extends CliError {
  constructor(message: string, where: Where = {}, exitCode: ExitCode = EXIT.VALIDATION) {
    super(message, exitCode, { file: "renox.toml", ...where });
  }
}

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0] as number;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j] as number;
      d[j] = Math.min((d[j] as number) + 1, (d[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length] as number;
}

const closest = (key: string, allowed: string[]): string | undefined =>
  allowed.map((k) => [k, distance(key.toLowerCase(), k)] as const).filter(([, n]) => n <= 2).sort((a, b) => a[1] - b[1])[0]?.[0];

/** 1-based line of `[table]` or of `key =` inside `[table]` (top level when table is ""). */
function lineOf(lines: string[], table: string, key?: string): number | undefined {
  let current = "";
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] as string).trim();
    const header = /^\[\s*([^\]]+?)\s*\]/u.exec(l);
    if (header) {
      current = header[1] as string;
      if (key === undefined && current === table) return i + 1;
      continue;
    }
    if (key !== undefined && current === table && new RegExp(`^["']?${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["']?\\s*=`, "u").test(l)) return i + 1;
  }
  return undefined;
}

/**
 * The line of a TOML syntax error: Bun's parser does not report it, so the
 * first prefix of the file that fails with the same message is taken.
 */
function syntaxErrorLine(text: string, message: string): number | undefined {
  const lines = text.split("\n");
  for (let n = 1; n <= lines.length; n++) {
    try {
      Bun.TOML.parse(`${lines.slice(0, n).join("\n")}\n`);
    } catch (e) {
      if ((e as Error).message === message) return n;
    }
  }
  return undefined;
}

const SCHEMA_KEYS = (schema: Json): string[] => (isObject(schema) && isObject(schema.properties) ? Object.keys(schema.properties) : []);

/** Unknown tables and keys, with the line and a suggestion. */
function unknownKeys(raw: Record<string, unknown>, lines: string[]): ConfigError[] {
  const out: ConfigError[] = [];
  const top = SCHEMA_KEYS(renoxTomlSchema);
  const props = (renoxTomlSchema as { properties: Record<string, Json> }).properties;
  for (const [k, v] of Object.entries(raw)) {
    if (!top.includes(k)) {
      const near = closest(k, top);
      const line = lineOf(lines, k) ?? lineOf(lines, "", k);
      out.push(
        new ConfigError(`unknown ${isObject(v) ? "table" : "key"} ${JSON.stringify(k)}`, {
          ...(line ? { line } : {}),
          hint: near ? `did you mean [${near}]?` : `renox.toml has the tables ${top.map((t) => `[${t}]`).join(", ")}`,
        }),
      );
      continue;
    }
    if (!isObject(v)) continue;
    const allowed = SCHEMA_KEYS(props[k] as Json);
    for (const key of Object.keys(v)) {
      if (allowed.includes(key)) continue;
      const near = closest(key, allowed);
      const line = lineOf(lines, k, key);
      out.push(
        new ConfigError(`unknown key ${JSON.stringify(key)} in [${k}]`, {
          ...(line ? { line } : {}),
          hint: near ? `did you mean ${near}?` : `[${k}] takes ${allowed.join(", ")}`,
        }),
      );
    }
  }
  return out;
}

/** An IANA time zone the runtime knows (`Intl`), e.g. `Asia/Dubai` or `UTC`. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** All problems of one file in one error: the first carries the location, the rest are listed. */
function combine(errors: ConfigError[]): ConfigError {
  const [first, ...rest] = errors as [ConfigError, ...ConfigError[]];
  if (rest.length === 0) return first;
  const more = rest.map((e) => `\n  renox.toml${e.line ? `:${e.line}` : ""}: ${e.message}${e.hint ? ` (${e.hint})` : ""}`).join("");
  return new ConfigError(`${first.message}${more}`, { ...(first.line ? { line: first.line } : {}), ...(first.hint ? { hint: first.hint } : {}) });
}

export function readProject(dir: string): ProjectConfig {
  const path = join(dir, "renox.toml");
  if (!existsSync(path))
    throw new ConfigError(
      "not found: this folder is not a Renox app",
      { hint: "run renox in the app folder (the one with renox.toml), or create an app with `renox new <name>`" },
      EXIT.USER,
    );
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (e) {
    const message = (e as Error).message.replace(/^TOML Parse error: /u, "");
    const line = syntaxErrorLine(text, (e as Error).message);
    throw new ConfigError(`invalid TOML: ${message}`, { ...(line ? { line } : {}), hint: "fix the TOML syntax (https://toml.io)" });
  }
  const unknown = unknownKeys(raw as Record<string, unknown>, lines);
  if (unknown.length) throw combine(unknown);
  const errors = validate(renoxTomlSchema, raw as Json);
  if (errors.length) {
    throw combine(
      errors.map((err) => {
        // "$.app.name: reason" → app.name, and the line of that key.
        const m = /^\$\.?([^:]*): (.*)$/u.exec(err);
        const keyPath = (m?.[1] ?? "").split(".").filter(Boolean);
        const line = keyPath.length >= 2 ? lineOf(lines, keyPath[0] as string, keyPath[1]) : keyPath[0] ? lineOf(lines, keyPath[0]) : undefined;
        return new ConfigError(`${keyPath.join(".") || "renox.toml"}: ${m?.[2] ?? err}`, line ? { line } : {});
      }),
    );
  }
  const c = raw as JsonLike;
  const app = c.app as ProjectConfig["app"];
  if (!isTimeZone(app.timezone)) {
    const line = lineOf(lines, "app", "timezone");
    throw new ConfigError(`app.timezone: unknown time zone ${JSON.stringify(app.timezone)}`, {
      ...(line ? { line } : {}),
      hint: 'use an IANA time zone name such as "Asia/Dubai", "Europe/London", or "UTC"',
    });
  }
  const perms = isObject(c.permissions) ? c.permissions : {};
  return {
    app,
    permissions: {
      network: (perms.network as string[] | undefined) ?? [],
      secrets: (perms.secrets as string[] | undefined) ?? [],
    },
    ...(isObject(c.limits) ? { limits: c.limits as ProjectConfig["limits"] } : {}),
  };
}

type JsonLike = { [key: string]: Json };
