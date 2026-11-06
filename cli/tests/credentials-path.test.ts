import { expect, test } from "bun:test";
import { join } from "node:path";

import { credentialsPath } from "../src/commands/login.ts";
import { cacheRoot } from "../src/lib/modules/official.ts";

test("credentialsPath: %APPDATA% on win32, XDG elsewhere", () => {
  const root = "C:\\Users\\a\\AppData\\Roaming";
  expect(credentialsPath({ APPDATA: root }, "win32")).toBe(join(root, "renox", "credentials.json"));
  expect(credentialsPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(join("/x", "renox", "credentials.json"));
  expect(credentialsPath({ HOME: "/h" }, "darwin")).toBe(join("/h", ".config", "renox", "credentials.json"));
});

test("cacheRoot: %LOCALAPPDATA% on win32, XDG elsewhere", () => {
  const root = "C:\\Users\\a\\AppData\\Local";
  expect(cacheRoot({ LOCALAPPDATA: root }, "win32")).toBe(join(root, "renox", "cache"));
  expect(cacheRoot({ XDG_CACHE_HOME: "/c" }, "linux")).toBe(join("/c", "renox", "modules"));
});
