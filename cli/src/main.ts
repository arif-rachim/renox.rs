#!/usr/bin/env bun
// renox: new, build, dev, check (F1). docs/12-developer-experience.md.

import { run as build } from "./commands/build.ts";
import { run as check } from "./commands/check.ts";
import { run as dev } from "./commands/dev.ts";
import { run as newApp } from "./commands/new.ts";

const USAGE = `renox <command>

  new <name> [--template blank|hello]   create an app
  build [--out <dir>]                   build the artifact into .renox/artifact/<hash>/
  dev [--port 8787]                     run the app on the local worker, rebuild on change
  check                                 validate config, routes, manifest; lint SQL and fetch

Environment: RENOX_WORKER_PATH overrides the renox-worker binary used by dev.`;

const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = { new: newApp, build, dev, check };

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const fn = cmd ? COMMANDS[cmd] : undefined;
  if (!fn) {
    console.error(USAGE);
    return cmd === undefined || cmd === "--help" || cmd === "help" ? 0 : 2;
  }
  try {
    return await fn(rest);
  } catch (e) {
    console.error(`renox ${cmd}: ${(e as Error).message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
