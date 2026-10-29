// The CLI runs only a renox-worker it can trace to a release of this
// repository (#129; cli/src/worker/verify.ts). Proves
// docs/24-threat-model.md section F, "Tampered release": a worker with one
// corrupted byte, or an external worker without a signature, is refused
// with RENOX_CLI_WORKER_UNVERIFIED (exit code 3) and the expected and actual
// sha256. cosign itself is replaced by a script that records its arguments;
// the real signatures are checked by the release workflows in a fresh
// container.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { targetTriple, WORKER_VERSION } from "../scripts/fetch-worker.ts";
import { EXIT } from "../src/errors.ts";
import { sha256Hex } from "../src/lib/hash.ts";
import { workerPath } from "../src/lib/worker.ts";
import { CODE, OIDC_ISSUER, PINNED_WORKER, verifyExternal, verifyPinned, WorkerUnverifiedError, workerIdentity } from "../src/worker/verify.ts";
import { MAIN } from "./negative/helpers.ts";

const root = mkdtempSync(join(tmpdir(), "renox-verify-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = (): string => {
  const d = join(root, String(n++));
  mkdirSync(d, { recursive: true });
  return d;
};

const TARGET = "x86_64-unknown-linux-gnu";
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].map((p) => targetTriple(...(p.split("-") as [string, string])));
const BODY = "#!/bin/sh\necho fake renox-worker\n";

/** A fake worker and a pin table that pins it. */
function pinnedWorker(): { path: string; pinned: Record<string, string> } {
  const path = join(dir(), "renox-worker");
  writeFileSync(path, BODY, { mode: 0o755 });
  return { path, pinned: { [TARGET]: sha256Hex(BODY) } };
}

/** Flip the low bit of one byte. */
function corrupt(path: string): void {
  const b = readFileSync(path);
  b[5] = (b[5] as number) ^ 1;
  writeFileSync(path, b);
}

function refusal(fn: () => unknown): WorkerUnverifiedError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WorkerUnverifiedError);
    return e as WorkerUnverifiedError;
  }
  throw new Error("expected RENOX_CLI_WORKER_UNVERIFIED");
}

test("the pins are for the pinned worker version and known targets", () => {
  expect(PINNED_WORKER.version).toBe(WORKER_VERSION);
  expect(Object.keys(PINNED_WORKER.sha256).length).toBeGreaterThan(0);
  for (const [target, hex] of Object.entries(PINNED_WORKER.sha256)) {
    expect(TARGETS).toContain(target);
    expect(hex).toMatch(/^[0-9a-f]{64}$/u);
  }
});

test("a worker with the pinned sha256 runs; one corrupted byte is refused with both hashes", () => {
  const { path, pinned } = pinnedWorker();
  verifyPinned(path, TARGET, pinned);
  corrupt(path);
  const e = refusal(() => verifyPinned(path, TARGET, pinned));
  const actual = sha256Hex(readFileSync(path));
  expect(e.code).toBe(CODE);
  expect(e.exitCode).toBe(EXIT.ENVIRONMENT);
  expect(e.expected).toBe(pinned[TARGET] as string);
  expect(e.actual).toBe(actual);
  expect(e.message).toBe(
    `${CODE}: refusing to run ${path}: it is not renox-worker ${PINNED_WORKER.version} for ${TARGET} (expected sha256 ${pinned[TARGET]}, actual ${actual})`,
  );
  expect(e.hint).toContain("fetch-worker.ts");
});

test("a target without a released worker is refused", () => {
  const { path } = pinnedWorker();
  const e = refusal(() => verifyPinned(path, "aarch64-apple-darwin", {}));
  expect(e.message).toContain("expected sha256 (none: no released worker for this target)");
});

test("the downloaded worker is checked when the CLI looks it up; RENOX_WORKER_PATH is the unverified override", () => {
  const bin = dir();
  const path = join(bin, `${process.platform}-${process.arch}`, "renox-worker");
  mkdirSync(join(bin, `${process.platform}-${process.arch}`));
  writeFileSync(path, BODY, { mode: 0o755 });
  const pins = (hex: string): Record<string, string> => Object.fromEntries(TARGETS.map((t) => [t, hex]));
  expect(workerPath("", bin, pins(sha256Hex(BODY)), undefined)).toBe(path);
  corrupt(path);
  const e = refusal(() => workerPath("", bin, pins(sha256Hex(BODY)), undefined));
  expect(e.message).toContain(`${CODE}: refusing to run ${path}`);
  // Installed beside a compiled renox (install.sh): the same check.
  const installed = join(dir(), "renox-worker");
  writeFileSync(installed, BODY, { mode: 0o755 });
  expect(workerPath("", dir(), pins(sha256Hex(BODY)), installed)).toBe(installed);
  corrupt(installed);
  refusal(() => workerPath("", dir(), pins(sha256Hex(BODY)), installed));
  // A worker built from source.
  expect(workerPath(path, bin, pins(sha256Hex(BODY)), undefined)).toBe(path);
});

/** A cosign stand-in: records its arguments, exits with `code`. */
function fakeCosign(code: number): { bin: string; log: string } {
  const d = dir();
  const log = join(d, "cosign.log");
  const bin = join(d, "cosign");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\n[ ${code} = 0 ] || echo "error: none of the expected identities matched" >&2\nexit ${code}\n`, { mode: 0o755 });
  return { bin, log };
}

/** An external (not pinned) worker with a signature bundle and a provenance bundle beside it. */
function signedWorker(): string {
  const d = dir();
  const path = join(d, `renox-worker-0.2.0-${TARGET}`);
  writeFileSync(path, "#!/bin/sh\necho another renox-worker\n", { mode: 0o755 });
  writeFileSync(`${path}.sigstore.json`, "{}");
  writeFileSync(join(d, "renox-worker-0.2.0.provenance.sigstore.json"), "{}");
  return path;
}

test("--worker: a pinned hash runs without cosign", () => {
  const { path, pinned } = pinnedWorker();
  expect(verifyExternal(path, { target: TARGET, pinned, cosign: join(root, "no-cosign") })).toBe("pinned");
});

test("--worker: an unsigned worker, or a corrupted pinned one, is refused", () => {
  const { path, pinned } = pinnedWorker();
  corrupt(path);
  const e = refusal(() => verifyExternal(path, { target: TARGET, pinned }));
  expect(e.message).toContain(`it is not the pinned worker and has no signature (${path}.sigstore.json)`);
  expect(e.message).toContain(`expected sha256 ${pinned[TARGET]}, actual ${sha256Hex(readFileSync(path))}`);
  // A signature but no provenance.
  writeFileSync(`${path}.sigstore.json`, "{}");
  expect(refusal(() => verifyExternal(path, { target: TARGET, pinned })).message).toContain("no single *.provenance.sigstore.json");
});

test("--worker: signature and provenance are verified by cosign against the worker release workflow", () => {
  const path = signedWorker();
  const cosign = fakeCosign(0);
  expect(verifyExternal(path, { target: TARGET, pinned: {}, cosign: cosign.bin })).toBe("signed");
  const identity = `--certificate-identity-regexp ${workerIdentity()} --certificate-oidc-issuer ${OIDC_ISSUER}`;
  expect(readFileSync(cosign.log, "utf8").trim().split("\n")).toEqual([
    `verify-blob --bundle ${path}.sigstore.json ${identity} ${path}`,
    `verify-blob-attestation --bundle ${join(path, "..", "renox-worker-0.2.0.provenance.sigstore.json")} --new-bundle-format --type slsaprovenance1 ${identity} ${path}`,
  ]);
  expect(workerIdentity("arif-rachim/renox.rs")).toBe("^https://github\\.com/arif-rachim/renox\\.rs/\\.github/workflows/release-worker\\.yml@refs/tags/worker-v");
  expect(new RegExp(workerIdentity()).test("https://github.com/arif-rachim/renox.rs/.github/workflows/release-worker.yml@refs/tags/worker-v0.2.0")).toBe(true);
  expect(new RegExp(workerIdentity()).test("https://github.com/someone/renox.rs/.github/workflows/release-worker.yml@refs/tags/worker-v0.2.0")).toBe(false);
  expect(new RegExp(workerIdentity()).test("https://github.com/arif-rachim/renox.rs/.github/workflows/release-cli.yml@refs/tags/worker-v0.2.0")).toBe(false);
});

test("--worker: a signature that does not verify, or no cosign, is refused", () => {
  const path = signedWorker();
  const e = refusal(() => verifyExternal(path, { target: TARGET, pinned: {}, cosign: fakeCosign(1).bin }));
  expect(e.message).toContain("its signature does not verify: error: none of the expected identities matched");
  const missing = refusal(() => verifyExternal(path, { target: TARGET, pinned: {}, cosign: join(root, "no-cosign") }));
  expect(missing.message).toContain("cosign is not installed");
  expect(missing.hint).toContain("install cosign");
});

test("renox dev --worker with a corrupted worker exits 3 with RENOX_CLI_WORKER_UNVERIFIED and starts nothing", () => {
  const { path } = pinnedWorker();
  corrupt(path);
  const r = Bun.spawnSync([process.execPath, MAIN, "dev", "--port", "1", "--worker", path], {
    cwd: dir(),
    env: { ...process.env, PATH: "/nonexistent" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = new TextDecoder().decode(r.stderr);
  expect(r.exitCode).toBe(EXIT.ENVIRONMENT);
  expect(err).toContain(`renox dev: ${CODE}: refusing to run ${path}`);
  expect(err).toContain(`actual ${sha256Hex(readFileSync(path))}`);
  const usage = Bun.spawnSync([process.execPath, MAIN, "dev", "--worker"], { cwd: dir(), stdout: "pipe", stderr: "pipe" });
  expect(usage.exitCode).toBe(EXIT.USER);
  expect(new TextDecoder().decode(usage.stderr)).toContain("usage: renox dev [--port <port>] [--worker <path>]");
});

// install.sh (#129): with cosign installed, the CLI download must carry a
// signature by release-cli.yml on a cli-v* tag; RENOX_REQUIRE_SIGNATURE=1
// refuses to install without one.
describe("install.sh signature check", () => {
  const INSTALL = join(import.meta.dir, "..", "scripts", "install.sh");
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const asset = `renox-0.1.0-${os}-${arch}`;
  const cli = "#!/bin/sh\necho renox\n";
  let signed = true;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === `/cli-v0.1.0/${asset}`) return new Response(cli);
      if (path === `/cli-v0.1.0/${asset}.sha256`) return new Response(`${sha256Hex(cli)}  ${asset}\n`);
      if (path === `/cli-v0.1.0/${asset}.sigstore.json` && signed) return new Response("{}");
      return new Response("not found", { status: 404 });
    },
  });
  afterAll(() => server.stop(true));

  /** Runs install.sh with only the system tools and, when given, a cosign stand-in on PATH. */
  async function install(cosign?: string, env: Record<string, string> = {}): Promise<{ code: number; err: string; installed: string }> {
    const d = dir();
    const tools = join(d, "tools");
    mkdirSync(tools);
    if (cosign) writeFileSync(join(tools, "cosign"), readFileSync(cosign), { mode: 0o755 });
    // Async: the fake release server above runs on this event loop.
    const r = Bun.spawn(["sh", INSTALL, "0.1.0"], {
      env: {
        HOME: d,
        PATH: `${tools}:/usr/bin:/bin`,
        RENOX_NO_WORKER: "1",
        RENOX_INSTALL_DIR: join(d, "bin"),
        RENOX_RELEASE_BASE: `http://127.0.0.1:${server.port}`,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([r.exited, new Response(r.stderr).text()]);
    return { code, err, installed: join(d, "bin", "renox") };
  }

  test("a signature cosign verifies is required by the release-cli identity", async () => {
    signed = true;
    const cosign = fakeCosign(0);
    const r = await install(cosign.bin);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`${asset}: signature verified (release-cli on cli-v0.1.0)`);
    expect(existsSync(r.installed)).toBe(true);
    const args = readFileSync(cosign.log, "utf8");
    expect(args).toContain("verify-blob --bundle ");
    expect(args).toContain(
      "--certificate-identity-regexp ^https://github\\.com/arif-rachim/renox\\.rs/\\.github/workflows/release-cli\\.yml@refs/tags/cli-v --certificate-oidc-issuer https://token.actions.githubusercontent.com",
    );
  });

  test("a signature that does not verify installs nothing", async () => {
    signed = true;
    const r = await install(fakeCosign(1).bin);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`the sigstore signature of ${asset} does not verify; nothing installed`);
    expect(existsSync(r.installed)).toBe(false);
  });

  test("without cosign or without a signature: checksum only, or refused with RENOX_REQUIRE_SIGNATURE=1", async () => {
    signed = true;
    const plain = await install();
    expect(plain.code).toBe(0);
    expect(plain.err).toContain(`cosign is not installed`);
    expect(plain.err).toContain(`${asset} is verified by its checksum only`);
    const required = await install(undefined, { RENOX_REQUIRE_SIGNATURE: "1" });
    expect(required.code).toBe(1);
    expect(required.err).toContain("RENOX_REQUIRE_SIGNATURE=1, so nothing is installed");
    expect(existsSync(required.installed)).toBe(false);
    signed = false;
    const unsigned = await install(fakeCosign(0).bin, { RENOX_REQUIRE_SIGNATURE: "1" });
    expect(unsigned.code).toBe(1);
    expect(unsigned.err).toContain(`cli-v0.1.0 has no signature for ${asset}`);
    expect(existsSync(unsigned.installed)).toBe(false);
  });
});
