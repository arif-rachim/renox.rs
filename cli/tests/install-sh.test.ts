// cli/scripts/install.sh on a system it has no build for (#431): under Git
// Bash, MSYS2 or Cygwin on Windows it stops before downloading anything and
// says how to use WSL 2 instead. `uname` is faked through PATH, so the test
// runs offline on Linux and macOS.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/install.sh");
const scratch = mkdtempSync(join(tmpdir(), "renox-install-sh-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runAs(system: string): { code: number; err: string } {
  const bin = mkdtempSync(join(scratch, "bin-"));
  writeFileSync(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -m) echo x86_64 ;; *) echo '${system}' ;; esac\n`);
  chmodSync(join(bin, "uname"), 0o755);
  // An unreachable release base: a download attempt would fail with another message.
  const r = Bun.spawnSync(["sh", script, "0.1.0"], {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: scratch, RENOX_RELEASE_BASE: "http://127.0.0.1:9" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, err: r.stderr.toString() };
}

test.each(["MINGW64_NT-10.0-22631", "MSYS_NT-10.0-22631", "CYGWIN_NT-10.0-22631"])("%s: no download, the WSL 2 steps instead", (system) => {
  const { code, err } = runAs(system);
  expect(code).toBe(1);
  expect(err).toContain("no native Windows build of renox; use WSL 2");
  expect(err).toContain("wsl --install -d Ubuntu");
  expect(err).not.toContain("download failed");
});

test("an unknown system names the supported ones and WSL 2", () => {
  const { code, err } = runAs("FreeBSD");
  expect(code).toBe(1);
  expect(err).toContain("no renox build for FreeBSD; Linux and macOS are supported (on Windows, use WSL 2)");
});
