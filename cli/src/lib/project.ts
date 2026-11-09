// renox.toml: read and validate. Every problem is a ConfigError naming
// renox.toml, the line when it can be found, and what to do
// (docs/23-failure-modes.md section 3, "missing renox.toml").

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT, type ExitCode, CliError, type Where } from "../errors.ts";
import { type Json, isObject, unsupportedKeywords, validate } from "./schema.ts";
import type { SecurityConfig } from "../check/security.ts";
import { renoxTomlSchema } from "./schemas.ts";

export interface ProjectConfig {
  app: { name: string; timezone: string };
  permissions: { network: string[]; secrets: string[] };
  limits?: { cpu_ms?: number; wall_ms?: number; memory_mb?: number; concurrency?: number };
  /** `[security]`, as written (validated by src/check/security.ts at build). */
  security?: SecurityConfig;
  /** Artifact 1.4: `[storage]` and `[ai]` (ops.md 1.7.0 sections 21, 23). */
  storage?: { allowed_types?: string[]; images?: { widths?: number[] } };
  ai?: { mode?: "direct" | "gateway" };
  /** Artifact 1.8: `[[slots]]`, the app's own slot fillers (partials of the app). */
  slots?: AppSlot[];
  /** Artifact 1.8: `[events."app.<name>"]`, the events the app declares and may emit. */
  events?: Record<string, { payload: Json; description?: string }>;
}

/** One `[[slots]]` entry of renox.toml (`manifest.md` section 4; `template` is an app partial). */
export interface AppSlot {
  name: string;
  template: string;
  requires?: string;
  /** 0 to 1000, default 100. */
  priority?: number;
}

const SLOT_NAME = /^[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63})+$/u;
const SLOT_TEMPLATE = /^partials(\/(?!\.\.?(\/|$))[A-Za-z0-9_.-]+)+\.html$/u;
const EVENT_NAME = /^app\.[a-z][a-z0-9_]{0,63}$/u;
const ACTION_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;

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
    // [modules] keys are module names, checked by src/lib/modules/resolve.ts.
    if (!isObject(v) || k === "modules" || k === "events") continue;
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
  const slots = readSlots(c.slots, lines);
  const events = readEvents(c.events, lines);
  const perms = isObject(c.permissions) ? c.permissions : {};
  return {
    app,
    permissions: {
      network: (perms.network as string[] | undefined) ?? [],
      secrets: (perms.secrets as string[] | undefined) ?? [],
    },
    ...(isObject(c.limits) ? { limits: c.limits as ProjectConfig["limits"] } : {}),
    ...(isObject(c.security) ? { security: c.security as SecurityConfig } : {}),
    ...(isObject(c.storage) ? { storage: c.storage as ProjectConfig["storage"] } : {}),
    ...(isObject(c.ai) ? { ai: c.ai as ProjectConfig["ai"] } : {}),
    ...(slots.length ? { slots } : {}),
    ...(events ? { events } : {}),
  };
}

/** 1-based line of the `index`-th `[[slots]]` header. */
function slotLine(lines: string[], index: number): number | undefined {
  let n = -1;
  for (let i = 0; i < lines.length; i++) if (/^\[\[\s*slots\s*\]\]/u.test((lines[i] as string).trim()) && ++n === index) return i + 1;
  return undefined;
}

/** `[[slots]]` (artifact 1.8): the shape of each entry; whether the template exists and `requires` is declared is `renox check`'s. */
function readSlots(raw: unknown, lines: string[]): AppSlot[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError("slots: must be an array of tables ([[slots]])", { hint: 'write [[slots]] with name, template = "partials/<x>.html"' });
  const errors: ConfigError[] = [];
  const out: AppSlot[] = [];
  raw.forEach((item, i) => {
    const at = slotLine(lines, i);
    const bad = (message: string, hint?: string): void => void errors.push(new ConfigError(`slots[${i}]: ${message}`, { ...(at ? { line: at } : {}), ...(hint ? { hint } : {}) }));
    if (!isObject(item)) return bad("must be a table");
    const allowed = ["name", "template", "requires", "priority"];
    for (const k of Object.keys(item)) if (!allowed.includes(k)) bad(`unknown key ${JSON.stringify(k)}`, closest(k, allowed) ? `did you mean ${closest(k, allowed)}?` : `[[slots]] takes ${allowed.join(", ")}`);
    if (typeof item.name !== "string" || !SLOT_NAME.test(item.name)) bad("name must be a dotted slot name such as app.header (lowercase letters, digits, _)");
    if (typeof item.template !== "string" || !SLOT_TEMPLATE.test(item.template) || item.template.length > 256) bad("template must be a partial of the app, such as partials/banner.html", "the file lives in partials/ and ends in .html");
    if (item.requires !== undefined && (typeof item.requires !== "string" || !ACTION_NAME.test(item.requires))) bad("requires must be an action name such as orders.read");
    if (item.priority !== undefined && (typeof item.priority !== "number" || !Number.isInteger(item.priority) || item.priority < 0 || item.priority > 1000)) bad("priority must be an integer from 0 to 1000");
    if (errors.length === 0) out.push(item as unknown as AppSlot);
  });
  if (errors.length) throw combine(errors);
  if (raw.length > 64) throw new ConfigError("slots: at most 64 [[slots]]");
  return out;
}

/** `[events."app.<name>"]` (artifact 1.8). */
function readEvents(raw: unknown, lines: string[]): ProjectConfig["events"] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ConfigError("events: must be a table", { hint: 'write [events."app.<name>"] with payload' });
  const entries = Object.entries(raw);
  if (entries.length === 0) return undefined;
  const errors: ConfigError[] = [];
  const out: NonNullable<ProjectConfig["events"]> = {};
  const lineFor = (name: string): number | undefined => lineOf(lines, `events.${JSON.stringify(name)}`) ?? lineOf(lines, `events.${name}`) ?? lineOf(lines, "events");
  for (const [name, ev] of entries) {
    const line = lineFor(name);
    const bad = (message: string, hint?: string): void => void errors.push(new ConfigError(`events.${JSON.stringify(name)}: ${message}`, { ...(line ? { line } : {}), ...(hint ? { hint } : {}) }));
    if (!EVENT_NAME.test(name)) {
      bad("an app event is named app.<name> (lowercase letters, digits, _; ^app\\.[a-z][a-z0-9_]{0,63}$)", "module events start with their module's name; only app.* is yours");
      continue;
    }
    if (!isObject(ev)) {
      bad("must be a table with payload");
      continue;
    }
    for (const k of Object.keys(ev)) if (k !== "payload" && k !== "description") bad(`unknown key ${JSON.stringify(k)}`, "an event takes payload and description");
    if (!isObject(ev.payload)) bad("payload is required and must be a JSON Schema object", 'payload = { type = "object", properties = { id = { type = "string" } } }');
    else for (const p of unsupportedKeywords(ev.payload)) bad(`payload ${p}`, "see docs/contracts/validate.ts for the supported JSON Schema keywords");
    if (ev.description !== undefined && (typeof ev.description !== "string" || ev.description.length > 200)) bad("description must be a string of at most 200 characters");
    if (isObject(ev.payload)) out[name] = { payload: ev.payload, ...(typeof ev.description === "string" ? { description: ev.description } : {}) };
  }
  if (entries.length > 64) errors.push(new ConfigError("events: at most 64 events"));
  if (errors.length) throw combine(errors);
  return out;
}

type JsonLike = { [key: string]: Json };
