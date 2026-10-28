// Shared by the negative-path tests: throwaway apps and running the CLI.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");

export const VALID_TOML = '[app]\nname = "neg"\ntimezone = "Asia/Dubai"\n\n[permissions]\nnetwork = []\nsecrets = []\n';
export const HEALTH = "export const GET = () => Response.json({ ok: true });\n";

/** A new folder under the system temp dir with `files` written into it. */
export function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-neg-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

export interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `renox <args>` in `cwd`; the temp path is replaced by `<app>` so messages snapshot. */
export function renox(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Run {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const clean = (b: Buffer): string => b.toString().split(cwd).join("<app>");
  return { exitCode: r.exitCode ?? -1, stdout: clean(r.stdout), stderr: clean(r.stderr) };
}

/** An executable that runs fake-worker.ts (the dev tests' renox-worker). */
export function fakeWorker(dir: string): string {
  const path = join(dir, "fake-worker.sh");
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-worker.ts")}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A free loopback port. */
export function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}
