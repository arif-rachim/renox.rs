// renox mcp [--project <dir>]: the local platform MCP server on stdio.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { createServer, serveStdio } from "./server.ts";

export async function run(args: string[]): Promise<number> {
  const p = args.indexOf("--project");
  const project = resolve(p >= 0 && args[p + 1] ? (args[p + 1] as string) : process.cwd());
  if (args.some((a, i) => a.startsWith("--") && a !== "--project" && args[i - 1] !== "--project")) {
    console.error("usage: renox mcp [--project <dir>]");
    return 2;
  }
  if (!existsSync(join(project, "renox.toml")))
    console.error(`renox mcp: no renox.toml in ${project}; docs resources work, project tools report the missing config`);
  console.error(`renox mcp: serving ${project} on stdio`);
  await serveStdio(createServer(project), Bun.stdin.stream(), (line) => process.stdout.write(`${line}\n`));
  return 0;
}
