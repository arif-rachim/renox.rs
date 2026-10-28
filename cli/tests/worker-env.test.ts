// The skip-or-fail switch for the tests that need renox-worker (#186): they
// skip locally without RENOX_WORKER_PATH and fail in CI, so the gap that hid
// them in the `ts` job (they skipped on every run) cannot reopen silently.
import { expect, test } from "bun:test";

import { testWorker } from "./worker-env.ts";

test("outside CI, no RENOX_WORKER_PATH: undefined, the worker tests skip", () => {
  expect(testWorker({})).toBeUndefined();
  expect(testWorker({ RENOX_WORKER_PATH: "" })).toBeUndefined();
});

test("in CI, no RENOX_WORKER_PATH: an error instead of a skip", () => {
  expect(() => testWorker({ CI: "true" })).toThrow("CI is set and RENOX_WORKER_PATH is not");
  expect(() => testWorker({ CI: "true", RENOX_WORKER_PATH: "" })).toThrow("CI is set and RENOX_WORKER_PATH is not");
});

test("RENOX_WORKER_PATH set: that path, in CI or not", () => {
  expect(testWorker({ RENOX_WORKER_PATH: "/w/renox-worker" })).toBe("/w/renox-worker");
  expect(testWorker({ CI: "true", RENOX_WORKER_PATH: "/w/renox-worker" })).toBe("/w/renox-worker");
});
