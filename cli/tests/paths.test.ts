import { expect, test } from "bun:test";

import { bundleOutputPath } from "../src/lib/build.ts";
import { toPosix } from "../src/lib/paths.ts";

test("toPosix turns backslashes into slashes", () => {
  expect(toPosix("a\\b\\c.ts")).toBe("a/b/c.ts");
  expect(toPosix("a/b")).toBe("a/b");
  expect(toPosix("")).toBe("");
});

test("bundleOutputPath is POSIX without a leading ./", () => {
  expect(bundleOutputPath(".\\functions\\api\\x.js")).toBe("functions/api/x.js");
  expect(bundleOutputPath("./functions/api/x.js")).toBe("functions/api/x.js");
});
