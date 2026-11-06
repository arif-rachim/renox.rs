// cli/scripts/install.ps1 (#508): downloads renox-<v>-windows-x64.exe and its
// .sha256 from a fake release served by Bun.serve, installs it only when the
// SHA-256 matches. Needs PowerShell 7 (`pwsh`); skipped where it is missing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/install.ps1");
const pwsh = Bun.which("pwsh");
const version = "9.9.9";
const asset = `renox-${version}-windows-x64.exe`;
const binary = Buffer.from("MZ fake renox.exe\n");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let scratch = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let digest = sha(binary);

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "renox-install-ps1-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === `/cli-v${version}/${asset}`) return new Response(binary);
      if (path === `/cli-v${version}/${asset}.sha256`) return new Response(`${digest}  ${asset}\n`);
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => {
  server?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

function install(dir: string): { code: number; err: string } {
  const r = Bun.spawnSync([pwsh as string, "-NoProfile", "-NonInteractive", "-File", script, version], {
    env: {
      ...process.env,
      RENOX_RELEASE_BASE: `http://127.0.0.1:${server?.port}`,
      RENOX_INSTALL_DIR: dir,
      RENOX_NO_MODIFY_PATH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, err: r.stderr.toString() };
}

test.skipIf(!pwsh)("a correct sha256 installs renox.exe", () => {
  digest = sha(binary);
  const dir = join(scratch, "ok");
  const { code, err } = install(dir);
  expect(err).toContain(`renox ${version}`);
  expect(code).toBe(0);
  expect(readFileSync(join(dir, "renox.exe")).equals(binary)).toBe(true);
});

test.skipIf(!pwsh)("a wrong sha256 exits 1 and installs nothing", () => {
  digest = sha(Buffer.from("something else"));
  const dir = join(scratch, "bad");
  const { code, err } = install(dir);
  expect(code).toBe(1);
  expect(err).toContain("checksum mismatch");
  expect(existsSync(join(dir, "renox.exe"))).toBe(false);
});
