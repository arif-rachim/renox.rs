#!/usr/bin/env bun
// renox: new, build, dev, check, mcp. docs/12-developer-experience.md.
// Exit codes: src/errors.ts and cli/README.md, "Exit codes".

import { run as build } from "./commands/build.ts";
import { run as check } from "./commands/check.ts";
import { run as dev } from "./commands/dev.ts";
import { run as newApp } from "./commands/new.ts";
import { CliError, EXIT, exitCodeOf, formatError } from "./errors.ts";
import { run as mcp } from "./mcp/command.ts";

const USAGE = `renox <command>

  new <name> [--template blank|hello]   create an app
  build [--out <dir>]                   build the artifact into .renox/artifact/<hash>/
  dev [--port 8787]                     run the app on the local worker, rebuild on change
  check [--secrets]                     validate config, routes, manifest; lint SQL, fetch, global state; scan for secrets
  mcp [--project <dir>]                 local MCP server on stdio for coding agents (docs, check, dev status)

Exit codes: 0 ok, 1 user error, 2 validation error, 3 environment error, 130 interrupted.
Environment: RENOX_WORKER_PATH overrides the renox-worker binary used by dev.`;

const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = { new: newApp, build, dev, check, mcp };

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const fn = cmd ? COMMANDS[cmd] : undefined;
  if (!fn) {
    if (cmd === undefined || cmd === "--help" || cmd === "help") {
      console.log(USAGE);
      return EXIT.OK;
    }
    console.error(`renox: unknown command ${JSON.stringify(cmd)}\n\n${USAGE}`);
    return EXIT.USER;
  }
  // Ctrl-C: `renox dev` stops its worker first and returns 130 itself.
  if (cmd !== "dev") process.once("SIGINT", () => process.exit(EXIT.INTERRUPTED));
  try {
    return await fn(rest);
  } catch (e) {
    if (e instanceof CliError) console.error(formatError(cmd as string, e));
    else console.error(`renox ${cmd}: internal error: ${(e as Error)?.stack ?? String(e)}`);
    return exitCodeOf(e);
  }
}

process.exitCode = await main(process.argv.slice(2));
