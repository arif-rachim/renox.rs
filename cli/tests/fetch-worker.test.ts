// cli/scripts/fetch-worker.ts (#154): one naming scheme with
// .github/workflows/release-worker.yml, a pinned worker version, and a
// download that is refused unless its SHA-256 matches.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../src/lib/hash.ts";
import {
  WORKER_VERSION,
  assetName,
  fetchWorker,
  parseSha256File,
  releaseUrl,
  targetTriple,
} from "../scripts/fetch-worker.ts";

test("assets are named renox-worker-<version>-<target> on the worker-v<version> release", () => {
  expect(WORKER_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(assetName("0.1.0", "linux", "x64")).toBe("renox-worker-0.1.0-x86_64-unknown-linux-gnu");
  expect(assetName("0.1.0", "linux", "arm64")).toBe("renox-worker-0.1.0-aarch64-unknown-linux-gnu");
  expect(assetName("0.1.0", "darwin", "arm64")).toBe("renox-worker-0.1.0-aarch64-apple-darwin");
  expect(assetName("0.1.0", "darwin", "x64")).toBe("renox-worker-0.1.0-x86_64-apple-darwin");
  expect(() => targetTriple("win32", "x64")).toThrow("no renox-worker build for win32-x64");
  expect(releaseUrl("0.1.0", "renox-worker-0.1.0-x86_64-unknown-linux-gnu", undefined)).toBe(
    "https://github.com/arif-rachim/renox.rs/releases/download/worker-v0.1.0/renox-worker-0.1.0-x86_64-unknown-linux-gnu",
  );
  expect(releaseUrl("0.1.0", "a", "http://127.0.0.1:1")).toBe("http://127.0.0.1:1/worker-v0.1.0/a");
});

test("fetch-worker reads .sha256 assets", () => {
  const hex = "a".repeat(64);
  expect(parseSha256File(`${hex}  renox-worker-0.1.0-x86_64-unknown-linux-gnu\n`)).toBe(hex);
  expect(parseSha256File(hex)).toBe(hex);
  expect(() => parseSha256File("nope")).toThrow();
});

// A fake release server with the GitHub layout.
const binary = new TextEncoder().encode("#!/bin/sh\necho fake renox-worker\n");
let sum = sha256Hex(binary);
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const asset = assetName(WORKER_VERSION);
    const path = new URL(req.url).pathname;
    if (path === `/worker-v${WORKER_VERSION}/${asset}`) return new Response(binary);
    if (path === `/worker-v${WORKER_VERSION}/${asset}.sha256`) return new Response(`${sum}  ${asset}\n`);
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

test("fetch-worker downloads the pinned version, verifies it, and installs it executable", async () => {
  process.env.RENOX_RELEASE_BASE = `http://127.0.0.1:${server.port}`;
  try {
    const dir = mkdtempSync(join(tmpdir(), "renox-fetch-"));
    const path = await fetchWorker(undefined, dir);
    expect(path).toBe(join(dir, "renox-worker"));
    expect(readFileSync(path)).toEqual(Buffer.from(binary));
    expect(statSync(path).mode & 0o777).toBe(0o755);

    // A tampered binary (the .sha256 no longer matches) is refused and not installed.
    sum = "0".repeat(64);
    const other = mkdtempSync(join(tmpdir(), "renox-fetch-"));
    await expect(fetchWorker(undefined, other)).rejects.toThrow("checksum mismatch");
    expect(() => statSync(join(other, "renox-worker"))).toThrow();

    await expect(fetchWorker("9.9.9", other)).rejects.toThrow("404");
    await expect(fetchWorker("latest", other)).rejects.toThrow("invalid version");
  } finally {
    delete process.env.RENOX_RELEASE_BASE;
  }
});
