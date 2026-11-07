import { expect, test } from "bun:test";

import { nothingToRelease, options } from "./bump-version.ts";

type State = Parameters<typeof options>[0];

const base: State = {
  workerTag: "worker-v0.4.0",
  cargo: "0.4.0",
  pinned: "0.4.0",
  workerCommits: [],
  pending: null,
  cliTag: "cli-v0.1.6",
  cliVersion: "0.1.6",
  cliUntagged: false,
  cliCommits: [],
};

const first = (s: State): string => options(s)[0]!.label;

test("nothing changed: nothing to release", () => {
  expect(nothingToRelease(base)).toBe(true);
});

test("worker code changed: worker + CLI is recommended", () => {
  const s = { ...base, workerCommits: ["runtime fix"] };
  expect(nothingToRelease(s)).toBe(false);
  expect(first(s)).toStartWith("Worker + CLI");
  expect(options(s).map((o) => o.label.split(":")[0])).toEqual(["Worker + CLI", "Worker only", "CLI only"]);
});

test("only CLI/SDK changed: CLI only is recommended", () => {
  expect(first({ ...base, cliCommits: ["cli fix"] })).toStartWith("CLI only");
});

test("a released worker the CLI does not pin: pin + CLI is recommended", () => {
  const s = { ...base, workerTag: "worker-v0.4.1", cargo: "0.4.1", pending: { version: "0.4.1", run: null, ready: true } };
  expect(nothingToRelease(s)).toBe(false);
  expect(first(s)).toStartWith("Pin worker 0.4.1");
  expect(options(s)[0]!.pins(s, "patch")).toBe("0.4.1");
});

test("a worker CI run still going: wait, then pin + CLI", () => {
  const run = { id: 1, status: "in_progress", conclusion: "", url: "u" };
  const s = { ...base, workerTag: "worker-v0.4.1", cargo: "0.4.1", pending: { version: "0.4.1", run, ready: false } };
  expect(first(s)).toStartWith("Wait for worker 0.4.1");
});

test("a CLI version on main without its tag: tag it first", () => {
  const s = { ...base, cliTag: "cli-v0.1.5", cliUntagged: true, cliCommits: ["x"] };
  expect(first(s)).toStartWith("Tag cli-v0.1.6");
});

test("crates/renox-cell bumped but not tagged: tag the worker", () => {
  const s = { ...base, cargo: "0.4.1" };
  expect(nothingToRelease(s)).toBe(false);
  expect(first(s)).toStartWith("Tag worker-v0.4.1");
});

test("worker + CLI pins the next worker version", () => {
  const s = { ...base, workerCommits: ["x"] };
  expect(options(s)[0]!.pins(s, "minor")).toBe("0.5.0");
});
