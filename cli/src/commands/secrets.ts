// renox secrets set <NAME> | list | rm <NAME>   [--app <name>]
//
// App secrets (docs/contracts/deploy-api.md section 9). The value of `set` is
// read from stdin (piped, or typed with the echo turned off), never from the
// command line, where it would land in the shell history and in `ps`. No
// command prints a value: the API never returns one, and the CLI never repeats
// what it read. A value is checked here first (8 bytes and 8 characters to
// 64 KiB, the rule the runtime's redaction needs), so a bad one is never sent.
//
// A new value is used by the next activation (`renox deploy`) or rollback;
// the running deployment keeps the secret version it pinned.

import { EnvironmentError, EXIT, UserError } from "../errors.ts";
import { readProject } from "../lib/project.ts";
import { apiAuth, apiRequest, cliErrorOf, defaultIo, errorBody, type Io } from "./login.ts";

const USAGE = "usage: renox secrets set <NAME> | list | rm <NAME>  [--app <name>]   (set reads the value from stdin)";
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const APP = /^[a-z][a-z0-9-]{0,49}$/u;
const MAX_VALUE_BYTES = 64 * 1024;

export interface SecretsIo extends Io {
  /** The value for `name`: stdin, or a hidden prompt on a terminal. */
  readValue: (name: string) => Promise<string>;
}

/** Reads a line from the terminal with the echo off; Ctrl-C exits 130. */
async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve) => {
      let value = "";
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") {
            stdin.off("data", onData);
            resolve(value);
            return;
          }
          if (ch === "\u0003") {
            process.stderr.write("\n");
            process.exit(EXIT.INTERRUPTED);
          }
          if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
          else value += ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
}

export const defaultSecretsIo = (): SecretsIo => ({
  ...defaultIo(),
  readValue: async (name) => (process.stdin.isTTY ? readHidden(`Value for ${name} (input hidden): `) : Bun.stdin.text()),
});

/** One trailing newline (from `echo` or a file) is not part of the value. */
export const trimValue = (raw: string): string => raw.replace(/\r?\n$/u, "");

/** Why a value is refused before it is sent, or null. The message never contains the value. */
export function valueProblem(value: string): string | null {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes === 0) return "the value is empty (pipe it on stdin: `printf %s \"$VALUE\" | renox secrets set NAME`)";
  if (bytes < 8 || [...value].length < 8) return `the value is too short (${[...value].length} characters; at least 8 are needed, so it can be redacted from logs)`;
  if (bytes > MAX_VALUE_BYTES) return `the value is ${bytes} bytes; at most ${MAX_VALUE_BYTES} are allowed`;
  return null;
}

async function ok<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw cliErrorOf(res.status, await errorBody(res));
  return (await res.json()) as T;
}

const day = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

export async function run(args: string[], io: SecretsIo = defaultSecretsIo(), project: string = process.cwd()): Promise<number> {
  const rest: string[] = [];
  let app: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--app") {
      app = args[++i] ?? "";
      if (!APP.test(app)) throw new UserError(`--app ${JSON.stringify(app)} is not an app name`, { hint: USAGE });
    } else if (a.startsWith("--")) throw new UserError(`unknown argument ${JSON.stringify(a)}`, { hint: USAGE });
    else rest.push(a);
  }
  const [sub, name, ...extra] = rest;
  const needsName = sub === "set" || sub === "rm";
  if (sub === undefined || !(needsName || sub === "list")) throw new UserError(sub === undefined ? "missing subcommand" : `unknown subcommand ${JSON.stringify(sub)}`, { hint: USAGE });
  if (sub === "set" && extra.length > 0) throw new UserError("the value is read from stdin, not from the command line", { hint: "printf %s \"$VALUE\" | renox secrets set NAME (or run it in a terminal and type it)" });
  if (extra.length > 0 || (sub === "list" && name !== undefined)) throw new UserError("too many arguments", { hint: USAGE });
  if (needsName && (name === undefined || !NAME.test(name))) throw new UserError(name === undefined ? "missing secret name" : `${JSON.stringify(name)} is not a secret name`, { hint: "names match ^[A-Z][A-Z0-9_]{0,63}$, for example STRIPE_KEY" });
  apiAuth(io.env);
  const appName = app ?? readProject(project).app.name;
  const base = `/v1/apps/${appName}/secrets`;

  if (sub === "list") {
    const r = await ok<{ version: number; secrets: { name: string; updated_at: number }[] }>(await apiRequest(io, "GET", base));
    if (r.secrets.length === 0) io.out(`No secrets for ${appName}.`);
    for (const s of r.secrets) io.out(`${s.name.padEnd(32)}  updated ${day(s.updated_at)}`);
    io.out(`secret version ${r.version}`);
    return EXIT.OK;
  }
  if (sub === "rm") {
    const r = await ok<{ name: string; version: number }>(await apiRequest(io, "DELETE", `${base}/${name}`));
    io.out(`Removed ${r.name} (secret version ${r.version}). The active deployment keeps it until the next \`renox deploy\` or rollback.`);
    return EXIT.OK;
  }
  let value: string;
  try {
    value = trimValue(await io.readValue(name as string));
  } catch (e) {
    throw new EnvironmentError(`cannot read the value from stdin: ${(e as Error).message}`);
  }
  const problem = valueProblem(value);
  if (problem !== null) throw new UserError(`${name}: ${problem}`);
  const r = await ok<{ name: string; version: number }>(await apiRequest(io, "PUT", `${base}/${name}`, { json: { value } }));
  io.out(`Set ${r.name} (secret version ${r.version}). The next \`renox deploy\` or rollback uses it; the active deployment keeps its pinned version.`);
  return EXIT.OK;
}
