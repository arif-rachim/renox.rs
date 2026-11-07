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
// The worker release (#531): the CLI release's worker-version.txt names it.
const workerVersion = "8.8.8";
const workerAsset = `renox-worker-${workerVersion}-x86_64-pc-windows-msvc.exe`;
const workerBinary = Buffer.from("MZ fake renox-worker.exe\n");
let workerDigest = sha(workerBinary);
let workerPublished = true;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "renox-install-ps1-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === `/cli-v${version}/${asset}`) return new Response(binary);
      if (path === `/cli-v${version}/${asset}.sha256`) return new Response(`${digest}  ${asset}\n`);
      if (path === `/cli-v${version}/worker-version.txt`) return new Response(`${workerVersion}\n`);
      if (workerPublished && path === `/worker-v${workerVersion}/${workerAsset}`) return new Response(workerBinary);
      if (workerPublished && path === `/worker-v${workerVersion}/${workerAsset}.sha256`) return new Response(`${workerDigest}  ${workerAsset}\n`);
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => {
  server?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

// Async: a spawnSync would block this process's event loop, so the Bun.serve
// release above could never answer the script's downloads.
async function install(dir: string): Promise<{ code: number; err: string }> {
  const r = Bun.spawn([pwsh as string, "-NoProfile", "-NonInteractive", "-File", script, version], {
    env: {
      ...process.env,
      RENOX_RELEASE_BASE: `http://127.0.0.1:${server?.port}`,
      RENOX_INSTALL_DIR: dir,
      RENOX_NO_MODIFY_PATH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([r.exited, new Response(r.stderr).text(), new Response(r.stdout).text()]);
  return { code, err };
}

// pwsh takes a few seconds to start on a CI runner.
const PWSH_TIMEOUT = 60_000;

test.skipIf(!pwsh)("a correct sha256 installs renox.exe", async () => {
  digest = sha(binary);
  const dir = join(scratch, "ok");
  const { code, err } = await install(dir);
  expect(err).toContain(`renox ${version}`);
  expect(code).toBe(0);
  expect(readFileSync(join(dir, "renox.exe")).equals(binary)).toBe(true);
}, PWSH_TIMEOUT);

test.skipIf(!pwsh)("a wrong sha256 exits 1 and installs nothing", async () => {
  digest = sha(Buffer.from("something else"));
  const dir = join(scratch, "bad");
  const { code, err } = await install(dir);
  expect(code).toBe(1);
  expect(err).toContain("checksum mismatch");
  expect(existsSync(join(dir, "renox.exe"))).toBe(false);
}, PWSH_TIMEOUT);

test.skipIf(!pwsh)("the worker is installed beside renox.exe as renox-worker.exe after its sha256 check (#531)", async () => {
  digest = sha(binary);
  workerDigest = sha(workerBinary);
  workerPublished = true;
  const dir = join(scratch, "worker-ok");
  const { code, err } = await install(dir);
  expect(code).toBe(0);
  expect(err).toContain(`renox-worker ${workerVersion}`);
  expect(readFileSync(join(dir, "renox.exe")).equals(binary)).toBe(true);
  expect(readFileSync(join(dir, "renox-worker.exe")).equals(workerBinary)).toBe(true);
}, PWSH_TIMEOUT);

test.skipIf(!pwsh)("a wrong worker sha256 exits 1 and installs no worker (#531)", async () => {
  digest = sha(binary);
  workerDigest = sha(Buffer.from("something else"));
  workerPublished = true;
  const dir = join(scratch, "worker-bad");
  const { code, err } = await install(dir);
  expect(code).toBe(1);
  expect(err).toContain("checksum mismatch");
  expect(existsSync(join(dir, "renox-worker.exe"))).toBe(false);
}, PWSH_TIMEOUT);

test.skipIf(!pwsh)("a worker release without a Windows build is a warning, and the CLI still installs (#531)", async () => {
  digest = sha(binary);
  workerPublished = false;
  const dir = join(scratch, "worker-missing");
  try {
    const { code, err } = await install(dir);
    expect(code).toBe(0);
    expect(err).toContain(`no Windows renox-worker in worker-v${workerVersion}`);
    expect(readFileSync(join(dir, "renox.exe")).equals(binary)).toBe(true);
    expect(existsSync(join(dir, "renox-worker.exe"))).toBe(false);
  } finally {
    workerPublished = true;
  }
}, PWSH_TIMEOUT);
