// #795 (artifact.md 1.13): `guard.deny_redirect`, the same-origin path a
// signed-in principal a page guard denies is sent to (303) instead of the
// 403. `renox build` carries it into the manifest; `renox build` and
// `renox check` refuse a path that is not same-origin (V25) and a redirect to
// the page's own path (a loop); `renox check --security` lists it.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { check, securityOutput } from "../src/commands/check.ts";
import { buildFiles } from "../src/lib/build.ts";
import { denyRedirectProblem, readGuard, v25Problems } from "../src/lib/policies.ts";
import { app } from "./authz-fixture.ts";

const TOML = `[app]\nname = "portal"\ntimezone = "Asia/Dubai"\n\n[authz]\nactions = ["staff.read"]\n`;

function project(guard: string, extra: Record<string, string> = {}): string {
  return app({
    "renox.toml": TOML,
    "pages/staff.html": "<h1>staff</h1>",
    "pages/staff.ts": `export const guard = ${guard};\nexport async function load() { return {}; }\n`,
    "pages/my.html": "<h1>my</h1>",
    ...extra,
  });
}

const ok = `{ action: "staff.read", deny_redirect: "/my" }`;

test("readGuard reads deny_redirect; denyRedirectProblem is the same-origin rule", () => {
  expect(readGuard(`export const guard = ${ok};`, "pages/staff.ts")).toEqual({ action: "staff.read", deny_redirect: "/my" });
  expect(readGuard(`export const guard = { action: "staff.read" };`, "pages/staff.ts")).toEqual({ action: "staff.read" });
  for (const good of ["/", "/my", "/my/orders?tab=open", "/a/b#c"]) expect(denyRedirectProblem(good)).toBeNull();
  for (const bad of ["//evil.com", "https://x", "\\x", "\\\\x", "my", "", "/a//b", "/a b", "/a\tb", "/a\nb", `/${"a".repeat(200)}`]) {
    expect(denyRedirectProblem(bad)).not.toBeNull();
  }
  expect(denyRedirectProblem(`/${"a".repeat(199)}`)).toBeNull();
});

test("readGuard refuses a bad deny_redirect", () => {
  for (const to of ['"//evil.com"', '"https://x"', '"\\\\x"', '"my"', `"/${"a".repeat(200)}"`]) {
    expect(() => readGuard(`export const guard = { action: "staff.read", deny_redirect: ${to} };`, "pages/staff.ts")).toThrow(/V25: guard\.deny_redirect/u);
  }
  expect(() => readGuard(`export const guard = { action: "staff.read", deny_redirect: 3 };`, "pages/staff.ts")).toThrow(/same-origin path/u);
});

test("v25Problems: the loop rule, and page routes only", () => {
  const actions = { actions: ["staff.read"] };
  const g = { action: "staff.read", deny_redirect: "/staff" };
  expect(v25Problems([{ kind: "page", path: "/staff", module: "pages/staff", guard: g }], actions, [])).toEqual([
    "V25: pages/staff: guard.deny_redirect is the page's own path /staff (a redirect loop)",
  ]);
  expect(v25Problems([{ kind: "page", path: "/staff", module: "pages/staff", guard: { ...g, deny_redirect: "/my" } }], actions, [])).toEqual([]);
  expect(v25Problems([{ kind: "function", path: "/api", module: "functions/api", guard: { ...g, deny_redirect: "/my" } }], actions, [])).toEqual([
    "V25: functions/api: guard.deny_redirect is for page routes only",
  ]);
});

test("renox build copies deny_redirect into the page's route entry", async () => {
  const dir = project(ok);
  try {
    const { manifest } = await buildFiles(dir);
    const route = (manifest.routes as { kind: string; path: string; guard?: unknown }[]).find((r) => r.path === "/staff");
    expect(route?.guard).toEqual({ action: "staff.read", deny_redirect: "/my" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renox check refuses a bad deny_redirect and a loop", async () => {
  for (const [to, why] of [
    ['"//evil.com"', "must not contain //"],
    ['"https://x"', "must start with /"],
    ['"\\\\x"', "must start with /"],
    ['"my"', "must start with /"],
    [`"/${"a".repeat(200)}"`, "longer than 200"],
    ['"/staff"', "redirect loop"],
  ] as const) {
    const dir = project(`{ action: "staff.read", deny_redirect: ${to} }`);
    try {
      const { errors } = await check(dir, { types: "skip" });
      expect(errors.map((e) => e.message).join("\n")).toContain(why);
      expect(errors.map((e) => e.message).join("\n")).toContain("V25");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("renox check accepts a good deny_redirect; --security lists the guard with a redirect", async () => {
  const dir = project(ok);
  try {
    const { errors } = await check(dir, { types: "skip" });
    expect(errors).toEqual([]);
    const out = securityOutput(dir);
    expect(out).toContain("Guards with a redirect");
    expect(out).toContain("/staff  guard staff.read  deny_redirect /my");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const plain = project(`{ action: "staff.read" }`);
  try {
    expect(securityOutput(plain)).not.toContain("Guards with a redirect");
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
