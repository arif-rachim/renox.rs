import { expect, test } from "bun:test";

import { changelogAddWorkerLine, changelogRelease, nextVersion, replaceAll } from "./lib.ts";
import { currentPinned, parseSums, rewritePins } from "./pin-worker.ts";

test("nextVersion bumps by kind or takes an explicit higher version", () => {
  expect(nextVersion("0.1.6", "patch")).toBe("0.1.7");
  expect(nextVersion("0.1.6", "minor")).toBe("0.2.0");
  expect(nextVersion("0.1.6", "major")).toBe("1.0.0");
  expect(nextVersion("0.1.6", "0.1.10")).toBe("0.1.10");
  expect(() => nextVersion("0.1.6", "0.1.6")).toThrow("not above");
  expect(() => nextVersion("0.1.6", "0.1.5")).toThrow("not above");
  expect(() => nextVersion("0.1.6", "v0.2")).toThrow("not a version");
});

test("replaceAll replaces every match and fails on none", () => {
  expect(replaceAll("a 1.0 b 1.0", /1\.0/u, "2.0")).toBe("a 2.0 b 2.0");
  expect(() => replaceAll("nothing here", /1\.0/u, "2.0", "f.md")).toThrow("f.md: no match");
});

const h = (c: string): string => c.repeat(64);
const VERIFY = `export const PINNED_WORKER = {
  version: "0.4.0",
  sha256: {
    "x86_64-unknown-linux-gnu": "${h("a")}",
    // a comment
    "x86_64-pc-windows-msvc": "${h("b")}",
  },
  pdf: {
    "x86_64-unknown-linux-gnu": "${h("c")}",
  },
};
`;

test("rewritePins takes each pinned target from the release sums", () => {
  const sums = parseSums(`${h("1")}  renox-worker-0.5.0-x86_64-unknown-linux-gnu\r\n${h("2")}  renox-worker-0.5.0-x86_64-pc-windows-msvc.exe\n${h("9")}  renox-worker-0.5.0-x86_64-unknown-linux-gnu-pdf.gz\n`);
  const unpacked = parseSums(`${h("3")}  renox-worker-0.5.0-x86_64-unknown-linux-gnu-pdf\n`);
  const out = rewritePins(VERIFY, "0.5.0", sums, unpacked);
  expect(currentPinned(out)).toBe("0.5.0");
  expect(out).toContain(`"x86_64-unknown-linux-gnu": "${h("1")}"`);
  expect(out).toContain(`"x86_64-pc-windows-msvc": "${h("2")}"`);
  expect(out).toContain(`pdf: {\n    "x86_64-unknown-linux-gnu": "${h("3")}"`);
  expect(out).toContain("// a comment");
});

test("rewritePins fails when the release lacks a pinned target", () => {
  const sums = parseSums(`${h("1")}  renox-worker-0.5.0-x86_64-unknown-linux-gnu\n`);
  expect(() => rewritePins(VERIFY, "0.5.0", sums, new Map())).toThrow("x86_64-pc-windows-msvc.exe");
});

const CHANGELOG = `# Changelog

Intro.

## 0.1.7 (unreleased)

Pins a new worker.

**Worker**

- Old line.

## 0.1.6 (2026-11-07)

Before.
`;

test("changelogRelease dates the entry and adds the install block", () => {
  const out = changelogRelease(CHANGELOG, "0.1.7", "2026-11-08");
  expect(out).toContain("## 0.1.7 (2026-11-08)\n\nPins a new worker.\n\n**Install**\n\n```sh\ncurl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.7/install.sh | sh\n```");
  expect(out).toContain("## 0.1.6 (2026-11-07)\n\nBefore.");
  expect(() => changelogRelease(CHANGELOG, "0.1.8", "2026-11-08")).toThrow("it has 0.1.7");
});

test("changelogRelease puts the install block before a leading subheading", () => {
  const opensWithWorker = CHANGELOG.replace("Pins a new worker.\n\n**Worker**", "**Worker**");
  const out = changelogRelease(opensWithWorker, "0.1.7", "2026-11-08");
  expect(out).toContain("## 0.1.7 (2026-11-08)\n\n**Install**\n\n```sh\n");
  expect(out).toContain("| iex`.\n\n**Worker**\n\n- Old line.");
});

test("changelogAddWorkerLine adds under **Worker**, or creates the entry", () => {
  expect(changelogAddWorkerLine(CHANGELOG, "- Pins 0.5.0.", "0.1.7")).toContain("**Worker**\n\n- Pins 0.5.0.\n- Old line.");
  const released = CHANGELOG.replace("## 0.1.7 (unreleased)\n\nPins a new worker.\n\n**Worker**\n\n- Old line.\n\n", "");
  const out = changelogAddWorkerLine(released, "- Pins 0.5.0.", "0.1.7");
  expect(out).toContain("Intro.\n\n## 0.1.7 (unreleased)\n\n**Worker**\n\n- Pins 0.5.0.\n\n## 0.1.6");
});

test("setUnreleased replaces the unreleased entry or adds one; renameUnreleased moves its version", async () => {
  const { setUnreleased, renameUnreleased, unreleasedBody } = await import("./lib.ts");
  const replaced = setUnreleased(CHANGELOG, "0.2.0", "New notes.");
  expect(replaced).toContain("Intro.\n\n## 0.2.0 (unreleased)\n\nNew notes.\n\n## 0.1.6 (2026-11-07)");
  expect(replaced).not.toContain("Old line.");
  const added = setUnreleased(changelogRelease(CHANGELOG, "0.1.7", "2026-11-08"), "0.1.8", "Next.");
  expect(added).toContain("Intro.\n\n## 0.1.8 (unreleased)\n\nNext.\n\n## 0.1.7 (2026-11-08)");
  expect(renameUnreleased(CHANGELOG, "0.2.0")).toContain("## 0.2.0 (unreleased)\n\nPins a new worker.");
  expect(unreleasedBody(CHANGELOG)).toBe("Pins a new worker.\n\n**Worker**\n\n- Old line.");
});
