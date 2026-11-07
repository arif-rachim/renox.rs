// A platform with no renox-worker build (Windows today) stops worker commands
// with RENOX_CLI_WORKER_UNAVAILABLE, exit code 3 (#507, parent #441). Does not
// use tests/worker-env.ts: it must run without any worker.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EXIT, formatError } from "../src/errors.ts";
import { UNAVAILABLE, WORKER_FILE, WorkerUnavailableError, workerPath } from "../src/lib/worker.ts";

const empty = mkdtempSync(join(tmpdir(), "renox-worker-unavailable-"));
const saved = process.env.RENOX_WORKER_PATH;
// `workerPath(undefined, ...)` falls back to the environment, so unset it.
beforeAll(() => {
  delete process.env.RENOX_WORKER_PATH;
});
afterAll(() => {
  if (saved !== undefined) process.env.RENOX_WORKER_PATH = saved;
  rmSync(empty, { recursive: true, force: true });
});

test("no build for the platform: RENOX_CLI_WORKER_UNAVAILABLE, exit 3", () => {
  let err: unknown;
  try {
    workerPath(undefined, empty, {}, undefined, {}, "win32-x64");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WorkerUnavailableError);
  const e = err as WorkerUnavailableError;
  expect(e.code).toBe("RENOX_CLI_WORKER_UNAVAILABLE");
  expect(UNAVAILABLE).toBe("RENOX_CLI_WORKER_UNAVAILABLE");
  expect(e.exitCode).toBe(EXIT.ENVIRONMENT);
  expect(formatError("dev", e)).toMatchSnapshot();
});

test("RENOX_WORKER_PATH wins over the platform check", () => {
  // The file must exist: an env path that does not is a different error.
  const w = join(empty, "w");
  writeFileSync(w, "");
  expect(workerPath(w, empty, {}, undefined, {}, "win32-x64")).toBe(resolve(w));
});

test("the worker file is renox-worker on Linux", () => {
  if (process.platform === "linux") expect(WORKER_FILE).toBe("renox-worker");
});

test("win32-x64 is a known target, but without a pinned sha256 the gate still fires (#531)", () => {
  let err: unknown;
  try {
    workerPath(undefined, empty, {}, undefined, {}, "win32-x64");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WorkerUnavailableError);
  expect((err as WorkerUnavailableError).code).toBe(UNAVAILABLE);
  expect(formatError("dev", err as WorkerUnavailableError)).toContain("not yet pinned");
  const w = join(empty, "w531");
  writeFileSync(w, "");
  expect(workerPath(w, empty, {}, undefined, {}, "win32-x64")).toBe(resolve(w));
});

test("a pinned triple passes the gate and reaches the lookup (#531)", () => {
  expect(() => workerPath(undefined, empty, { "x86_64-pc-windows-msvc": "a".repeat(64) }, undefined, {}, "win32-x64", empty)).toThrow(
    "no renox-worker binary",
  );
});
