// renox apps list [--deleted] [--json] | rm <name> [--yes] [--json] | restore <name> [--json]
//
// The tenant's apps (docs/contracts/deploy-api.md 0.7 section 3, #536).
// `rm` deletes one app: it stops serving at once and can be restored for 7
// days with `restore`, then it is purged. Without --yes, `rm` asks for the
// name to be typed again; a mismatch exits 2 before any request.
//
// The command is a small dispatcher: each subcommand is one entry of
// SUBCOMMANDS (#537 adds `rename`). No token is ever printed.

import { EXIT, UserError } from "../errors.ts";
import { apiAuth, apiRequest, cliErrorOf, defaultIo, errorBody, type Io } from "./login.ts";

export const USAGE = "usage: renox apps list [--deleted] [--json] | rm <name> [--yes] [--json] | restore <name> [--json]";
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

/** The single app name of `p`, checked for the shape of a name (it goes into the request path). */
export function appName(p: Parsed): string {
  const [name, ...extra] = p.positional;
  if (name === undefined) throw new UserError("missing app name", { hint: USAGE });
  if (extra.length > 0) throw new UserError("too many arguments", { hint: USAGE });
  if (!APP.test(name)) throw new UserError(`${JSON.stringify(name)} is not an app name`, { hint: "lowercase letters, digits and -, starting with a letter" });
  return name;
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

/** The subcommands; `rename` (#537) joins here. */
export const SUBCOMMANDS: Record<string, (p: Parsed, io: AppsIo) => Promise<number>> = { list, rm, restore };

export async function run(args: string[], io: AppsIo = defaultAppsIo()): Promise<number> {
  const [sub, ...rest] = args;
  const fn = sub === undefined ? undefined : SUBCOMMANDS[sub];
  if (fn === undefined) throw new UserError(sub === undefined ? "missing subcommand" : `unknown subcommand ${JSON.stringify(sub)}`, { hint: USAGE });
  const p = parse(rest);
  if (p.deleted && sub !== "list") throw new UserError("--deleted is for `apps list`", { hint: USAGE });
  if (p.yes && sub !== "rm") throw new UserError("--yes is for `apps rm`", { hint: USAGE });
  return fn(p, io);
}
