// renox db export [--out <file>] | import <file> | restore --at <time> --as <new-app>   [--app <name>]
//
// The app's database (docs/contracts/deploy-api.md 0.3 section 14, #258).
//
// - export: the API answers a signed URL that expires within 15 minutes; the
//   file is downloaded through that URL (never with the API token) and its
//   SHA-256 is checked against the one the API reported before it is kept.
//   A mismatch removes the partial file and is an error.
// - import: replaces the database of a *staging* app with a SQLite file. The
//   API refuses a production app and a file whose tables break the naming
//   rules (422 RENOX_IMPORT_REJECTED, with the reasons).
// - restore: restores the app's database as of a point in time into a new
//   app (0.3 never restores in place).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { EnvironmentError, EXIT, UserError } from "../errors.ts";
import { readProject } from "../lib/project.ts";
import { apiAuth, apiRequest, cliErrorOf, defaultIo, errorBody, type Io } from "./login.ts";

const USAGE = "usage: renox db export [--out <file>] | import <file> | restore --at <time> --as <new-app>  [--app <name>]";
const APP = /^[a-z][a-z0-9-]{0,49}$/u;
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

interface Export {
  url: string;
  expires_at: number;
  created_at: number;
  size_bytes: number;
  sha256: string;
  masking: string;
}

async function ok<T>(res: Response, status: number): Promise<T> {
  if (res.status !== status) throw cliErrorOf(res.status, await errorBody(res));
  return (await res.json()) as T;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");

/** `--at`: milliseconds since the epoch, or an ISO 8601 time with a zone. */
export function parseAt(raw: string): number {
  if (/^\d{1,16}$/u.test(raw)) return Number(raw);
  if (!/(Z|[+-]\d\d:?\d\d)$/u.test(raw)) throw new UserError(`--at ${JSON.stringify(raw)} has no time zone`, { hint: "use milliseconds since the epoch or an ISO time such as 2026-10-29T08:00:00Z" });
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new UserError(`--at ${JSON.stringify(raw)} is not a time`, { hint: "use milliseconds since the epoch or an ISO time such as 2026-10-29T08:00:00Z" });
  return ms;
}

export async function run(args: string[], io: Io = defaultIo(), project: string = process.cwd()): Promise<number> {
  const rest: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--app" || a === "--out" || a === "--at" || a === "--as") {
      const v = args[++i];
      if (v === undefined || v === "") throw new UserError(`${a} needs a value`, { hint: USAGE });
      flags[a.slice(2)] = v;
    } else if (a.startsWith("--")) throw new UserError(`unknown argument ${JSON.stringify(a)}`, { hint: USAGE });
    else rest.push(a);
  }
  const [sub, file, ...extra] = rest;
  if (sub !== "export" && sub !== "import" && sub !== "restore") throw new UserError(sub === undefined ? "missing subcommand" : `unknown subcommand ${JSON.stringify(sub)}`, { hint: USAGE });
  if (extra.length > 0 || (sub !== "import" && file !== undefined)) throw new UserError("too many arguments", { hint: USAGE });
  for (const [flag, subs] of [["out", ["export"]], ["at", ["restore"]], ["as", ["restore"]]] as const) {
    if (flags[flag] !== undefined && !(subs as readonly string[]).includes(sub)) throw new UserError(`--${flag} applies to \`renox db ${subs.join("|")}\` only`, { hint: USAGE });
  }
  if (flags.app !== undefined && !APP.test(flags.app)) throw new UserError(`--app ${JSON.stringify(flags.app)} is not an app name`, { hint: USAGE });
  // Arguments are checked before anything is read or sent.
  let at = 0;
  if (sub === "restore") {
    if (flags.at === undefined || flags.as === undefined) throw new UserError("restore needs --at <time> and --as <new-app>", { hint: USAGE });
    if (!APP.test(flags.as)) throw new UserError(`--as ${JSON.stringify(flags.as)} is not an app name`, { hint: USAGE });
    at = parseAt(flags.at);
  }
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  if (sub === "import") {
    if (file === undefined) throw new UserError("missing file", { hint: USAGE });
    const path = isAbsolute(file) ? file : join(project, file);
    if (!existsSync(path)) throw new UserError(`${file} does not exist`);
    bytes = new Uint8Array(readFileSync(path));
    if (bytes.length > MAX_IMPORT_BYTES) throw new UserError(`${file} is ${bytes.length} bytes; at most ${MAX_IMPORT_BYTES} can be imported`);
    if (new TextDecoder().decode(bytes.subarray(0, 16)) !== "SQLite format 3\u0000") throw new UserError(`${file} is not a SQLite database file`);
  }
  apiAuth(io.env);
  const app = flags.app ?? readProject(project).app.name;

  if (sub === "export") {
    const e = await ok<Export>(await apiRequest(io, "POST", `/v1/apps/${app}/backups/export`, { json: {} }), 201);
    const out = flags.out ?? `${app}-${stamp(e.created_at)}.db`;
    const path = isAbsolute(out) ? out : join(project, out);
    // The signed URL carries its own authorization; the API token is not sent.
    let res: Response;
    try {
      res = await io.fetch(e.url, { method: "GET" });
    } catch (err) {
      throw new EnvironmentError(`cannot download the export: ${(err as Error).message}`);
    }
    if (res.status !== 200) throw new EnvironmentError(`the export download answered ${res.status}`, { hint: "the URL expires after at most 15 minutes; run `renox db export` again" });
    const body = new Uint8Array(await res.arrayBuffer());
    const got = sha256(body);
    if (got !== e.sha256) throw new EnvironmentError(`the downloaded file's SHA-256 ${got} does not match the export's ${e.sha256}; nothing was written`, { hint: "run `renox db export` again" });
    const tmp = `${path}.partial`;
    writeFileSync(tmp, body, { mode: 0o600 });
    try {
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new EnvironmentError(`cannot write ${out}: ${(err as Error).message}`);
    }
    io.out(`Exported ${app} to ${out} (${body.length} bytes, sha256 ${got}).`);
    return EXIT.OK;
  }
  if (sub === "import") {
    const r = await ok<{ app: string; database: string; size_bytes: number; sha256: string; tables: string[] }>(
      await apiRequest(io, "POST", `/v1/apps/${app}/db/import`, { body: bytes as Uint8Array<ArrayBuffer>, headers: { "content-type": "application/vnd.sqlite3" } }),
      200,
    );
    io.out(`Imported ${file} into ${r.app} (${r.size_bytes} bytes, ${r.tables.length} tables: ${r.tables.join(", ")}).`);
    return EXIT.OK;
  }
  const r = await ok<{ app: { name: string; hostnames?: string[] }; deployment: { hash: string; state: string }; restored_to: number | null }>(
    await apiRequest(io, "POST", `/v1/apps/${app}/backups/restore`, { json: { timestamp: at, target: "new_app", name: flags.as } }),
    201,
  );
  const host = r.app.hostnames?.[0];
  io.out(`Restored ${app} as of ${new Date(r.restored_to ?? at).toISOString()} into the new app ${r.app.name} (deployment ${r.deployment.hash.slice(0, 12)}, ${r.deployment.state})${host ? ` at https://${host}` : ""}.`);
  return EXIT.OK;
}
