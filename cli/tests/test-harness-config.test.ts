// #462: `renox test` on macOS. The harness keeps its state under `$TMPDIR`,
// which there is `/var/...`, a symlink to `/private/var/...`. A relative
// `artifacts_dir` from that directory resolved physically by the worker lands
// in `/private/Users/...`, and the worker is refused at start-up. The config
// is absolute, and a worker that exits at start-up says why.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { EnvironmentError } from "../src/errors.ts";
import { startTestWorker, testWorkerConfig, workerError } from "../src/lib/test-harness.ts";

test("the worker config has only absolute paths, whatever the temp dir is", () => {
  // A symlinked state directory, as /var is on macOS.
  const root = mkdtempSync(join(tmpdir(), "renox-cfg-"));
  mkdirSync(join(root, "private", "var", "T"), { recursive: true });
  symlinkSync(join(root, "private", "var"), join(root, "var"));
  const state = join(root, "var", "T", "renox-test-x");
  const artifacts = join(root, "home", "dev", "my-app", ".renox", "test", "artifact");
  const text = testWorkerConfig(state, artifacts, 12345);
  const paths = Object.fromEntries([...text.matchAll(/^(\w+) = "(.*)"$/gmu)].map((m) => [m[1], m[2]]));
  for (const k of ["data_dir", "artifacts_dir", "routes_file", "meters_dir", "logs_dir"]) {
    expect([k, isAbsolute(paths[k] as string)]).toEqual([k, true]);
    expect(paths[k]).not.toContain("..");
  }
  expect(paths.artifacts_dir).toBe(artifacts);
  expect(paths.listen).toBe("127.0.0.1:12345");
});

test("a worker that exits at start-up: the error names its last line and the config", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "renox-cfg-")));
  const worker = join(dir, "renox-worker");
  writeFileSync(worker, `#!/bin/sh\necho '{"timestamp":"t","level":"ERROR","fields":{"message":"start","error":"create a worker directory: Permission denied (os error 13)"},"target":"renox_worker"}' >&2\nexit 1\n`);
  chmodSync(worker, 0o755);
  const artifacts = join(dir, "artifact");
  mkdirSync(join(artifacts, "h"), { recursive: true });
  let err: unknown;
  try {
    await startTestWorker({ project: dir, artifacts, hash: "h", worker, seeds: [] });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EnvironmentError);
  const e = err as EnvironmentError;
  expect(e.message).toBe("renox-worker exited during startup (exit code 1)");
  expect(e.hint).toContain("the worker said: start: create a worker directory: Permission denied (os error 13)");
  expect(e.hint).toContain("worker.toml");
});

test("workerError: message and error of a tracing line, or the line itself", () => {
  expect(workerError('{"level":"ERROR","fields":{"message":"start","error":"boom","stage":"config"}}')).toBe("start: boom: stage=config");
  expect(workerError("plain text")).toBe("plain text");
});
