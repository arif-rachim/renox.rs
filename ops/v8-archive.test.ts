// ops/v8-archive.sh: the CI step that verifies the prebuilt rusty_v8 archive
// before cargo runs (issue #109). Proves docs/24-threat-model.md F,
// "Tampered prebuilt rusty_v8 binary": one changed byte fails with a checksum
// message and leaves no archive for the build to use.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "v8-archive.sh");
const dir = mkdtempSync(join(tmpdir(), "v8-archive-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const target = "x86_64-unknown-linux-gnu";
const entry = `v150.4.0/librusty_v8_simdutf_release_${target}.a.gz`;
const archive = Buffer.from("not really V8, but the bytes the checksum was taken from");
const sha = createHash("sha256").update(archive).digest("hex");

const mirror = join(dir, "mirror");
mkdirSync(join(mirror, "v150.4.0"), { recursive: true });
writeFileSync(join(dir, "v8-checksums.txt"), `# comment\n${sha}  ${entry}\n`);
writeFileSync(join(dir, "Cargo.lock"), '[[package]]\nname = "v8"\nversion = "150.4.0"\n\n[[package]]\nname = "deno_v8"\nversion = "0.5.0"\n');

function run(args: string[], mirrorBytes?: Buffer) {
  if (mirrorBytes) writeFileSync(join(mirror, entry), mirrorBytes);
  const p = Bun.spawnSync(["bash", script, ...args], {
    env: {
      ...process.env,
      RENOX_V8_MIRROR: `file://${mirror}`,
      RENOX_V8_CHECKSUMS: join(dir, "v8-checksums.txt"),
      RENOX_CARGO_LOCK: join(dir, "Cargo.lock"),
    },
  });
  return { code: p.exitCode, stdout: p.stdout.toString().trim(), stderr: p.stderr.toString() };
}

test("fetch verifies the archive for the locked v8 version and prints its path", () => {
  const out = join(dir, "ok");
  const r = run(["fetch", target, out], archive);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(join(out, `librusty_v8_simdutf_release_${target}.a.gz`));
  expect(r.stderr).toContain("rusty_v8 archive verified");
});

test("one changed byte fails the fetch with a checksum message and leaves no archive", () => {
  const tampered = Buffer.from(archive);
  tampered[10] = (tampered[10] as number) ^ 1;
  const out = join(dir, "tampered");
  const r = run(["fetch", target, out], tampered);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("checksum mismatch");
  expect(r.stdout).toBe("");
  expect(existsSync(join(out, `librusty_v8_simdutf_release_${target}.a.gz`))).toBe(false);
});

test("verify rejects a changed byte in a local file", () => {
  const file = join(dir, "local.a.gz");
  const tampered = Buffer.from(archive);
  tampered[0] = (tampered[0] as number) ^ 0x80;
  writeFileSync(file, tampered);
  const r = run(["verify", file, entry]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(`checksum mismatch for ${entry}`);
});

test("a target or v8 version without a committed checksum fails", () => {
  const r = run(["fetch", "aarch64-unknown-linux-gnu", join(dir, "arm")], archive);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no checksum for v8 150.4.0 on aarch64-unknown-linux-gnu");
});

test("two v8 versions in the lockfile fail", () => {
  const lock = join(dir, "two.lock");
  writeFileSync(lock, '[[package]]\nname = "v8"\nversion = "130.0.7"\n\n[[package]]\nname = "v8"\nversion = "150.4.0"\n');
  const p = Bun.spawnSync(["bash", script, "fetch", target, join(dir, "two")], {
    env: { ...process.env, RENOX_V8_CHECKSUMS: join(dir, "v8-checksums.txt"), RENOX_CARGO_LOCK: lock },
  });
  expect(p.exitCode).toBe(1);
  expect(p.stderr.toString()).toContain("more than one v8 version");
});
