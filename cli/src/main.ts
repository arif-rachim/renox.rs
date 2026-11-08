#!/usr/bin/env bun
// renox: new, build, dev, check, authz, mcp, login, tokens, deploy, logs, secrets, domains, apps, db. docs/12-developer-experience.md.
// Exit codes: src/errors.ts and cli/README.md, "Exit codes".

import { existsSync } from "node:fs";
import { join } from "node:path";

import { run as add } from "./commands/add.ts";
import { run as apps } from "./commands/apps.ts";
import { run as authz } from "./commands/authz.ts";
import { run as build } from "./commands/build.ts";
import { run as check } from "./commands/check.ts";
import { run as db } from "./commands/db.ts";
import { run as deploy } from "./commands/deploy.ts";
import { run as dev } from "./commands/dev.ts";
import { run as login } from "./commands/login.ts";
import { run as logs } from "./commands/logs.ts";
import { run as newApp } from "./commands/new.ts";
import { run as remove } from "./commands/remove.ts";
import { run as domains } from "./commands/domains.ts";
import { run as secrets } from "./commands/secrets.ts";
import { run as tokens } from "./commands/tokens.ts";
import { CliError, EXIT, exitCodeOf, formatError } from "./errors.ts";
import { run as mcp } from "./mcp/command.ts";
import { run as jobs } from "./commands/jobs.ts";
import { run as migrate } from "./commands/migrate.ts";
import { run as test } from "./commands/test.ts";
import { run as publish } from "./commands/publish.ts";
import { run as approve } from "./commands/approve.ts";
import { CLI_VERSION } from "./commands/new.ts";
import { ensureWorker } from "./lib/worker.ts";
import { PINNED_WORKER } from "./worker/verify.ts";
import { commandHelp, HELP, overview, suggest, unknownFlag } from "./lib/usage.ts";

/** `renox --version`: the CLI and the renox-worker release it pins (the one `renox dev` runs; production runs its own). */
const VERSION_LINE = `renox ${CLI_VERSION} (renox-worker ${PINNED_WORKER.version})`;

/** The whole help, grouped (lib/usage.ts, #449). */
const USAGE = overview(VERSION_LINE.replace(/^renox /u, ""));

const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = { new: newApp, build, dev, check, add, authz, remove, migrate, jobs, test, mcp, publish, approve, login: (a) => login(a), tokens: (a) => tokens(a), deploy: (a) => deploy(a), logs: (a) => logs(a), secrets: (a) => secrets(a), domains: (a) => domains(a), apps: (a) => apps(a), db: (a) => db(a) };

/**
 * dev, test and migrate always run the worker. build needs it for .html files
 * and Cedar policies; an app with a pages/ or policies/ folder may have them
 * (a cheap, conservative test: an app with neither never needs a download).
 */
function needsWorker(cmd: string): boolean {
  if (cmd === "dev" || cmd === "test" || cmd === "migrate") return true;
  return cmd === "build" && (existsSync(join(process.cwd(), "pages")) || existsSync(join(process.cwd(), "policies")));
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const fn = cmd ? COMMANDS[cmd] : undefined;
  if (!fn) {
    if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
      // `renox help deploy` is `renox deploy --help`.
      const topic = cmd === "help" ? rest[0] : undefined;
      console.log(topic !== undefined && topic in HELP ? commandHelp(topic) : USAGE);
      return EXIT.OK;
    }
    if (cmd === "--version" || cmd === "-V" || cmd === "version") {
      console.log(VERSION_LINE);
      return EXIT.OK;
    }
    // #449: a suggestion and the way to the list, not the whole help.
    const near = suggest(cmd, Object.keys(COMMANDS));
    console.error(`renox: unknown command ${JSON.stringify(cmd)}${near === null ? "" : `. Did you mean "${near}"?`}\nRun \`renox --help\` for the list of commands.`);
    return EXIT.USER;
  }
  // #449: `renox <command> --help` (or -h) prints the command's usage; an
  // unknown flag is named before anything runs.
  const name = cmd as string;
  const passThrough = HELP[name]?.passThrough === true;
  if ((!passThrough && (rest.includes("--help") || rest.includes("-h"))) || (passThrough && rest[0] === "--help")) {
    console.log(commandHelp(name));
    return EXIT.OK;
  }
  const bad = unknownFlag(name, rest);
  if (bad !== null) {
    const near = suggest(bad, HELP[name]?.flags ?? []);
    console.error(`renox ${name}: unknown flag ${bad}${near === null ? "" : ` (did you mean ${near}?)`}\n\n${commandHelp(name)}`);
    return EXIT.USER;
  }
  // Ctrl-C: `renox dev` stops its worker first and returns 130 itself.
  if (cmd !== "dev") process.once("SIGINT", () => process.exit(EXIT.INTERRUPTED));
  try {
    // #440, D30: a CLI from npm has no worker; the first command that needs one downloads the pinned release.
    if (needsWorker(name) && !rest.includes("--worker")) await ensureWorker();
    return await fn(rest);
  } catch (e) {
    if (e instanceof CliError) console.error(formatError(cmd as string, e));
    else console.error(`renox ${cmd}: internal error: ${(e as Error)?.stack ?? String(e)}`);
    return exitCodeOf(e);
  }
}

process.exitCode = await main(process.argv.slice(2));
