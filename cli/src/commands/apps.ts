// renox apps list [--deleted] [--json] | rm <name> [--yes] [--json] | restore <name> [--json]
//            | rename <old> <new> [--yes] [--json]
//
// The tenant's apps (docs/contracts/deploy-api.md 0.7 section 3, #536).
// `rm` deletes one app: it stops serving at once and can be restored for 7
// days with `restore`, then it is purged. Without --yes, `rm` asks for the
// name to be typed again; a mismatch exits 2 before any request.
// `rename` (#537) gives an app a new name with everything it holds; run in
// the app's folder (a renox.toml whose [app] name is the old name), it offers
// to write the new name there (--yes writes it without asking), changing
// only that value and keeping the file's line endings.
//
// The command is a small dispatcher: each subcommand is one entry of
// SUBCOMMANDS. No token is ever printed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT, UserError } from "../errors.ts";
import { apiAuth, apiRequest, cliErrorOf, defaultIo, errorBody, type Io } from "./login.ts";

export const USAGE = "usage: renox apps list [--deleted] [--json] | rm <name> [--yes] [--json] | restore <name> [--json] | rename <old> <new> [--yes] [--json]";
const APP = /^[a-z][a-z0-9-]{0,49}$/u;

export interface App {
  name: string;
  tenant_id: string;
  created_at: number;
  active_deployment: string | null;
  hostnames: string[];
  deleted_at?: number;
  restorable_until?: number;
}

export interface AppsIo extends Io {
  /** One line typed at a prompt (the prompt goes to stderr); "" when stdin is closed. */
  ask: (prompt: string) => Promise<string>;
  /** Messages that are not the command's output (the refusal of a mismatch). */
  err: (line: string) => void;
  /** The folder `rename` looks for a renox.toml in; the current directory when absent. */
  cwd?: string;
}

async function askLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  for await (const line of console) return line;
  return "";
}

export const defaultAppsIo = (): AppsIo => ({ ...defaultIo(), ask: askLine, err: (l) => console.error(l) });

/** The parsed arguments of one subcommand. */
export interface Parsed {
  positional: string[];
  json: boolean;
  yes: boolean;
  deleted: boolean;
}

export function parse(args: string[]): Parsed {
  const p: Parsed = { positional: [], json: false, yes: false, deleted: false };
  for (const a of args) {
    if (a === "--json") p.json = true;
    else if (a === "--yes" || a === "-y") p.yes = true;
    else if (a === "--deleted") p.deleted = true;
    else if (a.startsWith("-")) throw new UserError(`unknown argument ${JSON.stringify(a)}`, { hint: USAGE });
    else p.positional.push(a);
  }
  return p;
}

/** `name` checked for the shape of an app name (it goes into the request path). */
function checkName(name: string): string {
  if (!APP.test(name)) throw new UserError(`${JSON.stringify(name)} is not an app name`, { hint: "lowercase letters, digits and -, starting with a letter, at most 50" });
  return name;
}

/** The single app name of `p`, checked for the shape of a name (it goes into the request path). */
export function appName(p: Parsed): string {
  const [name, ...extra] = p.positional;
  if (name === undefined) throw new UserError("missing app name", { hint: USAGE });
  if (extra.length > 0) throw new UserError("too many arguments", { hint: USAGE });
  return checkName(name);
}

/**
 * `text` (a renox.toml) with the value of `name` in its `[app]` table changed
 * from `from` to `to`, and nothing else changed: other lines, comments, the
 * quotes and the line endings (LF or CRLF) stay as they are. Null when the
 * `[app]` name is not `from` or the line has a shape this edit does not
 * handle (the caller then says what to change by hand).
 */
export function setTomlAppName(text: string, from: string, to: string): string | null {
  const parts = text.split(/(\r?\n)/u);
  let table: string | null = null;
  let done = false;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] as string;
    const header = /^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(?:#.*)?$/u.exec(line);
    if (header !== null) {
      table = header[1] as string;
      continue;
    }
    if (table !== "app" || done) continue;
    const m = /^(\s*name\s*=\s*)(["'])([^"'\\]*)\2(\s*(?:#.*)?)$/u.exec(line);
    if (m === null) continue;
    if (m[3] !== from) return null;
    parts[i] = `${m[1]}${m[2]}${to}${m[2]}${m[4]}`;
    done = true;
  }
  if (!done) return null;
  const out = parts.join("");
  try {
    const parsed = Bun.TOML.parse(out) as { app?: { name?: unknown } };
    return parsed.app?.name === to ? out : null;
  } catch {
    return null;
  }
}

/** The `[app] name` of the renox.toml in `dir`, or null (no file, or not readable as TOML). */
function tomlAppName(path: string): string | null {
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as { app?: { name?: unknown } };
    return typeof parsed.app?.name === "string" ? parsed.app.name : null;
  } catch {
    return null;
  }
}

async function ok<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw cliErrorOf(res.status, await errorBody(res));
  return (await res.json()) as T;
}

/** A date as the CLI prints it: UTC, to the minute. */
export const when = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

async function list(p: Parsed, io: AppsIo): Promise<number> {
  if (p.positional.length > 0) throw new UserError("too many arguments", { hint: USAGE });
  const r = await ok<{ apps: App[] }>(await apiRequest(io, "GET", p.deleted ? "/v1/apps?deleted=true" : "/v1/apps"));
  if (p.json) {
    io.out(JSON.stringify(r));
    return EXIT.OK;
  }
  if (r.apps.length === 0) {
    io.out(p.deleted ? "No deleted app can be restored." : "No apps yet. Create one with `renox deploy` in an app folder.");
    return EXIT.OK;
  }
  for (const a of r.apps) {
    if (p.deleted) io.out(`${a.name.padEnd(30)}  restorable until ${when(a.restorable_until ?? 0)}`);
    else io.out(`${a.name.padEnd(30)}  ${(a.active_deployment === null ? "no live deployment" : a.active_deployment.slice(0, 12)).padEnd(18)}  ${a.hostnames[0] === undefined ? "" : `https://${a.hostnames[0]}`}`);
  }
  return EXIT.OK;
}

async function rm(p: Parsed, io: AppsIo): Promise<number> {
  const name = appName(p);
  apiAuth(io.env);
  if (!p.yes) {
    const typed = (await io.ask(`Deleting ${name} stops serving it now; it can be restored for 7 days, then it is purged.\nType the app name to confirm: `)).trim();
    if (typed !== name) {
      io.err(`renox apps rm: ${JSON.stringify(typed)} is not ${JSON.stringify(name)}; nothing was deleted`);
      return EXIT.VALIDATION;
    }
  }
  const r = await ok<{ name: string; deleted_at: number; restorable_until: number }>(await apiRequest(io, "DELETE", `/v1/apps/${name}`, { json: { confirm: name } }));
  if (p.json) io.out(JSON.stringify(r));
  else io.out(`${r.name} deleted. Restorable until ${when(r.restorable_until)} with: renox apps restore ${r.name}`);
  return EXIT.OK;
}

async function restore(p: Parsed, io: AppsIo): Promise<number> {
  const name = appName(p);
  const res = await apiRequest(io, "POST", `/v1/apps/${name}/restore`);
  if (res.status === 404) throw new UserError(`no app ${name}, or the restore window has passed`, { hint: "`renox apps list --deleted` lists the apps that can be restored" });
  const app = await ok<App>(res);
  if (p.json) io.out(JSON.stringify(app));
  else io.out(`${app.name} restored: ${app.hostnames[0] === undefined ? "(no hostname)" : `https://${app.hostnames[0]}`}`);
  return EXIT.OK;
}

/** What `rename` did with the renox.toml of the folder it ran in. */
type TomlOutcome = "updated" | "kept" | "unchanged" | "none";

async function rename(p: Parsed, io: AppsIo): Promise<number> {
  const [from, to, ...extra] = p.positional;
  if (from === undefined || to === undefined) throw new UserError("rename needs the old and the new name", { hint: USAGE });
  if (extra.length > 0) throw new UserError("too many arguments", { hint: USAGE });
  checkName(from);
  checkName(to);
  if (from === to) throw new UserError("the new name is the old one", { hint: USAGE });
  apiAuth(io.env);
  const res = await apiRequest(io, "POST", `/v1/apps/${from}/rename`, { json: { name: to } });
  if (res.status === 404) throw new UserError(`no app ${from}`, { hint: "`renox apps list` lists the tenant's apps" });
  if (res.status === 409) {
    const e = await errorBody(res);
    const field = e.details?.[0]?.field;
    if (field === "name") throw new UserError(`the name ${to} is not available`, { hint: "it is in use, reserved, or recently freed by another tenant; choose another" });
    throw cliErrorOf(409, e);
  }
  const app = await ok<App>(res);
  const host = app.hostnames[0];
  const oldHost = host?.startsWith(`${to}.`) ? `${from}${host.slice(to.length)}` : null;

  // The renox.toml of the folder, when it names the old app.
  const tomlPath = join(io.cwd ?? process.cwd(), "renox.toml");
  let toml: TomlOutcome = "none";
  if (existsSync(tomlPath) && tomlAppName(tomlPath) === from) {
    let write = p.yes;
    if (!write) write = /^y(es)?$/iu.test((await io.ask(`Update [app] name in renox.toml to "${to}"? [y/N] `)).trim());
    if (!write) toml = "kept";
    else {
      const text = readFileSync(tomlPath, "utf8");
      const next = setTomlAppName(text, from, to);
      if (next === null) toml = "kept";
      else {
        writeFileSync(tomlPath, next);
        toml = "updated";
      }
    }
  } else if (existsSync(tomlPath)) toml = "unchanged";

  if (p.json) {
    io.out(JSON.stringify({ ...app, renamed_from: from, renox_toml: toml }));
    return EXIT.OK;
  }
  io.out(`${from} renamed to ${app.name}: ${host === undefined ? "(no hostname)" : `https://${host}`}`);
  if (oldHost !== null) io.out(`  https://${oldHost} is no longer served; its users sign in again on https://${host}`);
  if (toml === "updated") io.out(`  renox.toml: [app] name = "${to}"`);
  if (toml === "kept") io.out(`  renox.toml still says name = "${from}": set [app] name = "${to}" before the next renox deploy`);
  return EXIT.OK;
}

/** The subcommands. */
export const SUBCOMMANDS: Record<string, (p: Parsed, io: AppsIo) => Promise<number>> = { list, rm, restore, rename };

export async function run(args: string[], io: AppsIo = defaultAppsIo()): Promise<number> {
  const [sub, ...rest] = args;
  const fn = sub === undefined ? undefined : SUBCOMMANDS[sub];
  if (fn === undefined) throw new UserError(sub === undefined ? "missing subcommand" : `unknown subcommand ${JSON.stringify(sub)}`, { hint: USAGE });
  const p = parse(rest);
  if (p.deleted && sub !== "list") throw new UserError("--deleted is for `apps list`", { hint: USAGE });
  if (p.yes && sub !== "rm" && sub !== "rename") throw new UserError("--yes is for `apps rm` and `apps rename`", { hint: USAGE });
  return fn(p, io);
}
