// #791: `renox.toml [authz] user_attrs` (docs/contracts/manifest.md 1.8.0, MF19):
// at most 8 boolean attribute names for `Renox::User`, each
// `^[a-z][a-z0-9_]{1,31}$`, none of the platform's. The attrs reach the
// artifact's `authz` block unchanged (artifact.md 1.12).

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { check } from "../src/commands/check.ts";
import { buildFiles } from "../src/lib/build.ts";
import { MAX_USER_ATTRS, PLATFORM_USER_ATTRS, userAttrProblems } from "../src/lib/policies.ts";
import { app, BASE, TOML } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

const withAttrs = (list: string): Record<string, string> => ({ ...BASE, "renox.toml": TOML.replace('sensitive = ["doc.edit"]', `sensitive = ["doc.edit"]\nuser_attrs = ${list}`) });

test("MF19: valid names, none declared, and the platform list", () => {
  expect(userAttrProblems(undefined)).toEqual([]);
  expect(userAttrProblems({ user_attrs: ["portal", "vip_2", "ab"] })).toEqual([]);
  expect(PLATFORM_USER_ATTRS).toContain("has_password");
  expect(PLATFORM_USER_ATTRS).toContain("id");
});

test("MF19: a bad name, too many, a platform name, a duplicate and a module's user_attrs are each named", () => {
  expect(userAttrProblems({ user_attrs: ["Portal", "a", "has-dash", "x".repeat(33)] })).toHaveLength(4);
  expect(userAttrProblems({ user_attrs: ["Portal"] })[0]).toBe('MF19: [authz] user_attrs "Portal" does not match ^[a-z][a-z0-9_]{1,31}$');
  const nine = Array.from({ length: MAX_USER_ATTRS + 1 }, (_, i) => `flag_${i}`);
  expect(userAttrProblems({ user_attrs: nine })).toEqual(["MF19: [authz] user_attrs declares 9 names, more than 8"]);
  for (const n of PLATFORM_USER_ATTRS) expect(userAttrProblems({ user_attrs: [n] })[0]).toContain(`user_attrs "${n}" is a platform attribute of Renox::User`);
  expect(userAttrProblems({ user_attrs: ["portal", "portal"] })).toEqual(['MF19: [authz] user_attrs names "portal" twice']);
  expect(userAttrProblems({ user_attrs: ["x1"] }, [{ name: "billing", authz: { user_attrs: ["portal"] } }])).toEqual(["MF19: billing: [authz] user_attrs is only for the app's renox.toml"]);
});

test("renox check refuses a bad user_attrs (platform name, bad name, too many) with MF19", async () => {
  for (const list of ['["has_password"]', '["Portal"]', `[${Array.from({ length: 9 }, (_, i) => `"flag_${i}"`).join(", ")}]`]) {
    const dir = app(withAttrs(list));
    try {
      const r = await check(dir);
      expect(r.errors.some((e) => e.message.includes("MF19")) || r.errors.some((e) => String((e as { details?: unknown }).details ?? "").includes("MF19")), list).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test.skipIf(!worker)("renox build puts user_attrs on the artifact's authz block", async () => {
  const dir = app(withAttrs('["portal"]'));
  try {
    const built = await buildFiles(dir);
    expect(built.manifest.authz?.user_attrs).toEqual(["portal"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
