#!/usr/bin/env bun
// renox: new, build, dev, check, mcp, login, tokens, deploy, logs, secrets, db. docs/12-developer-experience.md.
// Exit codes: src/errors.ts and cli/README.md, "Exit codes".

import { run as add } from "./commands/add.ts";
import { run as build } from "./commands/build.ts";
import { run as check } from "./commands/check.ts";
import { run as db } from "./commands/db.ts";
import { run as deploy } from "./commands/deploy.ts";
import { run as dev } from "./commands/dev.ts";
import { run as login } from "./commands/login.ts";
import { run as logs } from "./commands/logs.ts";
import { run as newApp } from "./commands/new.ts";
import { run as remove } from "./commands/remove.ts";
import { run as secrets } from "./commands/secrets.ts";
import { run as tokens } from "./commands/tokens.ts";
import { CliError, EXIT, exitCodeOf, formatError } from "./errors.ts";
import { run as mcp } from "./mcp/command.ts";
import { run as migrate } from "./commands/migrate.ts";
import { run as test } from "./commands/test.ts";

const USAGE = `renox <command>

  new <name> [--template blank|hello]   create an app
  build [--out <dir>]                   build the artifact into .renox/artifact/<hash>/
  dev [--port 8787]                     run the app on the local worker, rebuild on change
  dev --worker <path>                   run another renox-worker; it must be the pinned release or carry
                                        a sigstore signature and provenance that cosign verifies
  check [--secrets] [--security] [--json] [--strict]
                                        validate config, routes, templates, manifest, modules and renox.lock; lint SQL, fetch, global state;
                                        scan for secrets; --security prints the effective headers per route; --json prints the report as JSON;
                                        --strict fails on a drifted template override
  migrate [--db <file>]                 run the migrations of the installed modules (lock order) and the app's on the dev database
  test [pattern...] [--seed <file.sql>] run tests/*.test.ts on the worker with a temporary tenant file per test file (renox/test)
  add <module> [--version <range>] [--source path:<dir>|git:<url>#<ref>] [--mount <path>] [--yes]
                                        install a module: resolve it, show the permissions it asks for, write renox.toml and renox.lock
  remove <module>                       uninstall a module (its tables stay: migrations are forward-only)
  mcp [--project <dir>]                 local MCP server on stdio for coding agents (docs, check, dev status)
  login [--api <url>] [--with-token]    sign in to the control plane (device code; --with-token reads a token from stdin)
  tokens list | create <name> --scope <s>... [--expires-days n] | revoke <id>
                                        manage tenant tokens (the value is shown once)
  deploy [--json]                       build, upload, validate and activate the app; prints the live URL
  deploy --rollback [<hash>] [--app <name>]
                                        switch back to the previous (or the named) deployment
  logs [--follow] [--since <t>] [--source all|server|client] [--deployment <hash>] [--app <name>] [--json] [--raw]
                                        the app's log lines (--follow keeps streaming)
  secrets set <NAME> | list | rm <NAME> [--app <name>]
                                        app secrets; set reads the value from stdin and never prints it
  db export [--out <file>] | import <file> | restore --at <time> --as <new-app> [--app <name>]
                                        download the database (sha256 checked), import into a staging app, restore into a new app

Exit codes: 0 ok, 1 user error, 2 validation error, 3 environment error, 130 interrupted.
Environment: RENOX_WORKER_PATH overrides the renox-worker binary used by dev (not verified: for a worker you built);
RENOX_TOKEN and RENOX_API_URL override the credentials saved by login.`;

const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = { new: newApp, build, dev, check, add, remove, migrate, test, mcp, login: (a) => login(a), tokens: (a) => tokens(a), deploy: (a) => deploy(a), logs: (a) => logs(a), secrets: (a) => secrets(a), db: (a) => db(a) };

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
