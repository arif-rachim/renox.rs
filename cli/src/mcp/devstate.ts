// `.renox/dev.json`: what a running `renox dev` reports about itself, read by
// the MCP tools `dev_status` and `dev_errors`. Written by `renox dev` on start
// and after every build; removed on a clean stop.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A problem in the shape the CLI and MCP share (docs/20-ai-agents-mcp.md, "Tools"). */
export interface Problem {
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  hint?: string;
}

export interface DevState {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  artifact: string;
  routes: number;
  lastBuild: { ok: boolean; at: string; ms: number; problems: Problem[] };
  workerRestarts: number;
}

export const devStatePath = (project: string): string => join(project, ".renox", "dev.json");

export function writeDevState(project: string, state: DevState): void {
  const path = devStatePath(project);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearDevState(project: string): void {
  rmSync(devStatePath(project), { force: true });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The state of a live `renox dev` for this project, or null (none, or a stale file of a dead process). */
export function readDevState(project: string): DevState | null {
  const path = devStatePath(project);
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as DevState;
    return typeof s.pid === "number" && alive(s.pid) ? s : null;
  } catch {
    return null;
  }
}

/** `file:line:col` at the start of a message (the transpiler's and the linter's form), as a Problem. */
export function problemFromMessage(code: string, message: string): Problem {
  const m = /^([^\s:]+\.[a-z]+):(\d+)(?::(\d+))?[:\s]+(.*)$/su.exec(message);
  if (!m) return { code, message };
  return { code, file: m[1] as string, line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}), message: m[4] as string };
}

/** A thrown error as a Problem: the CliError's location and hint, its class as the code. */
export function problemOf(e: unknown): Problem {
  if (!(e instanceof Error)) return { code: "internal", message: String(e) };
  const name = e.constructor.name;
  const code =
    name === "ConfigError" ? "config" : name === "RouteError" ? "route" : name === "BuildError" ? "build" : name === "EnvironmentError" ? "environment" : name === "UserError" ? "usage" : "internal";
  const w = e as Error & { file?: string; line?: number; column?: number; hint?: string };
  if (w.file === undefined) return { ...problemFromMessage(code, e.message), ...(w.hint ? { hint: w.hint } : {}) };
  return {
    code,
    message: e.message,
    file: w.file,
    ...(w.line !== undefined ? { line: w.line } : {}),
    ...(w.column !== undefined ? { column: w.column } : {}),
    ...(w.hint ? { hint: w.hint } : {}),
  };
}
