// #640 (artifact 1.9, ADR D32): a module's `services` and `hooks` entries and
// the app's `hooks` entry are `eager: false` unless the module says
// `[module] eager = true`; a `hooks` entry records the hook names and event
// names read statically from its source; a `hooks.ts` whose keys cannot be
// read is refused by `renox check` and `renox build` unless the module is eager.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkArtifactFiles } from "@renox/artifact-validate";

import { BuildError, buildFiles, entriesOf } from "../src/lib/build.ts";
import { LAZY_MODULES_WORKER, lazyModuleEntries, readHookKeys } from "../src/lib/hook-keys.ts";
import { contractProblems, installedModules } from "../src/lib/modules/build.ts";
import { AUTH_TOML, shopWithAuth } from "./shop-auth-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

const keys = (src: string) => {
  const r = readHookKeys(src);
  if (!r.ok) throw new Error(r.problem);
  return r.keys;
};

describe("readHookKeys", () => {
  test("identifier keys, string keys and method shorthand, sorted", () => {
    const src = `
export const hooks = {
  "auth.send_mail": { async handle(ctx, args) { return 1; } },
  'org.send_mail': { handle: async () => {} },
};
export const on = {
  zed: async () => {},
  async "email.send_requested"(ctx, e) { await ctx.x(); },
  "auth.user_registered": async (ctx, e) => {},
  alpha() {},
  get beta() { return 1; },
  *gen() {},
};
`;
    expect(keys(src)).toEqual({
      hooks: ["auth.send_mail", "org.send_mail"],
      on: ["alpha", "auth.user_registered", "beta", "email.send_requested", "gen", "zed"],
    });
  });

  test("empty objects and absent exports give empty lists", () => {
    expect(keys("export const hooks = {};\nexport const on = {};\n")).toEqual({ hooks: [], on: [] });
    expect(keys("export const on = { };\n")).toEqual({ hooks: [], on: [] });
    expect(keys("export function other() {}\n")).toEqual({ hooks: [], on: [] });
  });

  test("nested objects, calls and arrays are skipped; type annotations and satisfies are fine", () => {
    const src = `
type H = Record<string, unknown>;
export const hooks: H = {
  "a.one": { handle: async (ctx, args: { x: number; y: { z: string } }) => ({ ok: [1, 2, { k: 1 }], f: (a, b) => a, b }) },
  "a.two": fn(1, { "not.a.key": 2 }, [3, 4]),
  "a.three": cond ? { x: 1 } : { y: 2 },
} satisfies H;
export const on = { "e.x": async () => {} } as const;
`;
    expect(keys(src)).toEqual({ hooks: ["a.one", "a.three", "a.two"], on: ["e.x"] });
  });

  test("braces, quotes, comments, templates and regexes inside values do not confuse the scan", () => {
    const src = `
// export const hooks = { "ghost.hook": 1 };
/* export const on = { "ghost.event": 1 } */
const note = "export const hooks = { nope: 1 }";
export const hooks = {
  /* "commented.out": 1, */
  "a.one": { handle: async () => { const s = "}"; const t = '{'; const u = \`\${ "}" } { \${ \`}\` }\`; return s + t + u; } },
  // "line.comment": 1,
  "a.two": { handle: async () => /[}"']/.test("x") && 1 / 2 },
  "a.three": async () => { /* } */ return { a: 1 }; },
};
export const on = {
  "e.one": async (ctx, e) => { if (e.x) { return; } },
  "e.two": () => "{{{",
};
`;
    expect(keys(src)).toEqual({ hooks: ["a.one", "a.three", "a.two"], on: ["e.one", "e.two"] });
  });

  test("a key the source does not spell out cannot be read", () => {
    const problem = (src: string) => {
      const r = readHookKeys(src);
      return r.ok ? null : r.problem;
    };
    expect(problem("const k = 'a.b';\nexport const hooks = { [k]: {} };\n")).toContain("computed");
    expect(problem("const o = {};\nexport const on = { ...o, 'a.b': 1 };\n")).toContain("spreads");
    expect(problem("const h = {};\nexport const hooks = h;\n")).toContain("not an object literal");
    expect(problem("export { hooks } from './other.ts';\n")).toContain("exported other than");
    expect(problem("const hooks = {};\nexport { hooks };\n")).toContain("exported other than");
    expect(problem("export * from './other.ts';\n")).toContain("export *");
    expect(problem("export function on() {}\n")).toContain("exported other than");
  });
});

/** A temp tree with the given files, removed after the test. */
const dirs: string[] = [];
// The tests of the lazy shape run without RENOX_BUILD_EAGER and with RENOX_BUILD_LAZY_MODULES=1
// (the pinned worker may predate lazy module entries); both variables are put back as found.
const eagerEnv = process.env.RENOX_BUILD_EAGER;
const lazyEnv = process.env.RENOX_BUILD_LAZY_MODULES;
beforeEach(() => {
  delete process.env.RENOX_BUILD_EAGER;
  process.env.RENOX_BUILD_LAZY_MODULES = "1";
});
afterEach(() => {
  if (eagerEnv === undefined) delete process.env.RENOX_BUILD_EAGER;
  else process.env.RENOX_BUILD_EAGER = eagerEnv;
  if (lazyEnv === undefined) delete process.env.RENOX_BUILD_LAZY_MODULES;
  else process.env.RENOX_BUILD_LAZY_MODULES = lazyEnv;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-lazy-"));
  dirs.push(dir);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

const HOOKS_TS = `export const hooks = { "auth.send_mail": { async handle() {} } };\nexport const on = { "auth.user_registered": async () => {}, "org.created": async () => {} };\n`;
const ENTRY = { "functions/api/x": "functions/api/x.js", "modules/mail/services": "modules/mail/services.js", "modules/mail/hooks": "modules/mail/hooks.js", hooks: "hooks.js", "pages/_error": "pages/_error.js" };
const CODE = new Map([
  ["functions/api/x.js", "export function GET(){}\n"],
  ["modules/mail/services.js", "export async function send(){}\n"],
  ["modules/mail/hooks.js", "export const hooks = {};\nexport const on = {};\n"],
  ["hooks.js", "export const on = {};\n"],
  ["pages/_error.js", "export function load(){}\n"],
]);

describe("lazyModuleEntries: only for a pinned worker that evaluates them", () => {
  test("off before worker 0.8.0, on from it; RENOX_BUILD_LAZY_MODULES overrides", () => {
    delete process.env.RENOX_BUILD_LAZY_MODULES;
    expect(lazyModuleEntries("0.7.0")).toBe(false);
    expect(lazyModuleEntries(LAZY_MODULES_WORKER)).toBe(true);
    expect(lazyModuleEntries("0.9.1")).toBe(true);
    process.env.RENOX_BUILD_LAZY_MODULES = "1";
    expect(lazyModuleEntries("0.7.0")).toBe(true);
    process.env.RENOX_BUILD_LAZY_MODULES = "0";
    expect(lazyModuleEntries("0.9.1")).toBe(false);
  });

  test("with lazyModules false, module entries keep the 1.8 shape and route modules stay lazy", () => {
    const entries = entriesOf(ENTRY, CODE, { lazyModules: false });
    for (const [id, e] of Object.entries(entries)) {
      expect(e.hooks).toBeUndefined();
      expect(e.on).toBeUndefined();
      if (id.startsWith("modules/") || id === "hooks") expect(e.eager).toBeUndefined();
    }
  });
});

describe("entriesOf, artifact 1.9", () => {
  test("module services and hooks and the app's hooks are lazy; hooks entries record their names; _error stays eager", () => {
    const dir = tree({ "mail-hooks.ts": HOOKS_TS, "app-hooks.ts": `export const on = { "mail.sent": async () => {} };\n` });
    const entries = entriesOf(ENTRY, CODE, {
      hookSources: new Map([
        ["modules/mail/hooks", join(dir, "mail-hooks.ts")],
        ["hooks", join(dir, "app-hooks.ts")],
      ]),
    });
    expect(entries).toEqual({
      "functions/api/x": { exports: ["GET"], eager: false },
      hooks: { exports: ["on"], eager: false, hooks: [], on: ["mail.sent"] },
      "modules/mail/hooks": { exports: ["hooks", "on"], eager: false, hooks: ["auth.send_mail"], on: ["auth.user_registered", "org.created"] },
      "modules/mail/services": { exports: ["send"], eager: false },
      "pages/_error": { exports: ["load"] },
    });
  });

  test("[module] eager = true keeps the module's entries eager, and still records the names it can read", () => {
    const dir = tree({ "mail-hooks.ts": HOOKS_TS, "app-hooks.ts": "export const on = {};\n" });
    const entries = entriesOf(ENTRY, CODE, {
      eagerModules: new Set(["mail"]),
      hookSources: new Map([
        ["modules/mail/hooks", join(dir, "mail-hooks.ts")],
        ["hooks", join(dir, "app-hooks.ts")],
      ]),
    });
    expect(entries["modules/mail/services"]).toEqual({ exports: ["send"] });
    expect(entries["modules/mail/hooks"]).toEqual({ exports: ["hooks", "on"], hooks: ["auth.send_mail"], on: ["auth.user_registered", "org.created"] });
    // The app has no opt-out.
    expect(entries.hooks?.eager).toBe(false);
  });

  test("an eager module whose keys cannot be read records no lists", () => {
    const dir = tree({ "mail-hooks.ts": "const k = 'a.b';\nexport const hooks = { [k]: {} };\nexport const on = {};\n", "app-hooks.ts": "export const on = {};\n" });
    const entries = entriesOf(ENTRY, CODE, {
      eagerModules: new Set(["mail"]),
      hookSources: new Map([
        ["modules/mail/hooks", join(dir, "mail-hooks.ts")],
        ["hooks", join(dir, "app-hooks.ts")],
      ]),
    });
    expect(entries["modules/mail/hooks"]).toEqual({ exports: ["hooks", "on"] });
  });

  test("keys that cannot be read are refused, naming the file, unless the module is eager; the app is always refused", () => {
    const dir = tree({ "mail-hooks.ts": "const k = 'a.b';\nexport const hooks = { [k]: {} };\n", "app-hooks.ts": "const o = {};\nexport const on = { ...o };\n", "ok.ts": "export const on = {};\n" });
    const mail = join(dir, "mail-hooks.ts");
    const app = join(dir, "app-hooks.ts");
    const fail = (sources: Parameters<typeof entriesOf>[2]) => {
      try {
        entriesOf(ENTRY, CODE, sources);
      } catch (e) {
        expect(e).toBeInstanceOf(BuildError);
        return (e as BuildError).message;
      }
      throw new Error("entriesOf did not throw");
    };
    const m = fail({ hookSources: new Map([["modules/mail/hooks", mail], ["hooks", join(dir, "ok.ts")]]) });
    expect(m).toContain("mail-hooks.ts");
    expect(m).toContain("computed");
    expect(m).toContain("eager = true");
    const a = fail({ eagerModules: new Set(["mail"]), hookSources: new Map([["modules/mail/hooks", mail], ["hooks", app]]) });
    expect(a).toContain("app-hooks.ts");
    expect(a).toContain("the app's hooks.ts");
    expect(a).not.toContain("eager = true");
  });

  test("V23: a filled hook that the lock does not approve is refused", () => {
    const dir = tree({ "mail-hooks.ts": HOOKS_TS, "app-hooks.ts": "export const on = {};\n" });
    const sources = (approved: string[]) => ({
      approvedHooks: new Map([["mail", approved]]),
      hookSources: new Map([["modules/mail/hooks", join(dir, "mail-hooks.ts")], ["hooks", join(dir, "app-hooks.ts")]]),
    });
    expect(() => entriesOf(ENTRY, CODE, sources([]))).toThrow(/mail fills the hook "auth\.send_mail", which is not in its approved permissions\.hooks/u);
    expect(entriesOf(ENTRY, CODE, sources(["auth.send_mail"]))["modules/mail/hooks"]?.hooks).toEqual(["auth.send_mail"]);
  });

  test("RENOX_BUILD_EAGER=1 keeps every module entry eager with no lists (the 1.8 shape)", () => {
    const dir = tree({ "mail-hooks.ts": HOOKS_TS, "app-hooks.ts": "export const on = {};\n" });
    process.env.RENOX_BUILD_EAGER = "1";
    try {
      const entries = entriesOf(ENTRY, CODE, {
        hookSources: new Map([["modules/mail/hooks", join(dir, "mail-hooks.ts")], ["hooks", join(dir, "app-hooks.ts")]]),
      });
      expect(entries).toEqual({
        "functions/api/x": { exports: ["GET"] },
        hooks: { exports: ["on"] },
        "modules/mail/hooks": { exports: ["hooks", "on"] },
        "modules/mail/services": { exports: ["send"] },
        "pages/_error": { exports: ["load"] },
      });
    } finally {

    }
  });
});

describe("renox check, V23 on hooks.ts", () => {
  const unreadable = "const k = 'a.b';\nexport const on = { [k]: async () => {} };\n";

  test("a module hooks.ts with keys that cannot be read is refused, naming the file, unless the module is eager", async () => {
    const dir = await shopWithAuth({}, { "hooks.ts": unreadable });
    try {
      const found = contractProblems(dir, installedModules(dir).modules).filter((p) => p.rule === "V23");
      expect(found).toHaveLength(1);
      expect(found[0]?.file).toBe("auth/hooks.ts");
      expect(found[0]?.message).toContain("the hooks.ts of auth");
      expect(found[0]?.message).toContain("computed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const eager = await shopWithAuth({}, { "hooks.ts": unreadable, "module.toml": AUTH_TOML.replace('version = "1.0.0"', 'version = "1.0.0"\neager = true') });
    try {
      expect(contractProblems(eager, installedModules(eager).modules).filter((p) => p.rule === "V23")).toEqual([]);
    } finally {
      rmSync(eager, { recursive: true, force: true });
    }
  });

  test("the app's hooks.ts with keys that cannot be read is refused", async () => {
    const dir = await shopWithAuth({ "hooks.ts": "const o = {};\nexport const on = { ...o };\n" });
    try {
      const found = contractProblems(dir, installedModules(dir).modules).filter((p) => p.rule === "V23");
      expect(found.map((p) => p.file)).toEqual(["hooks.ts"]);
      expect(found[0]?.message).toContain("the app's hooks.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!worker)("renox build, artifact 1.9", () => {
  const AUTH_HOOKS = `export const hooks = {};\nexport const on = { "org.created": async () => {}, async "org.member_added"(ctx, e) {} };\n`;
  const APP_HOOKS = `export const on = { "auth.user_registered": async () => {} };\n`;

  test("lazy by default with the recorded names, and the shared validator accepts it", async () => {
    const dir = await shopWithAuth({ "hooks.ts": APP_HOOKS }, { "hooks.ts": AUTH_HOOKS });
    try {
      const r = await buildFiles(dir);
      expect(checkArtifactFiles(r.files).violations).toEqual([]);
      const e = r.manifest.entries ?? {};
      expect(e["modules/auth/services"]).toEqual({ exports: ["currentUser"], eager: false });
      expect(e["modules/auth/hooks"]).toEqual({ exports: ["hooks", "on"], eager: false, hooks: [], on: ["org.created", "org.member_added"] });
      expect(e.hooks).toEqual({ exports: ["on"], eager: false, hooks: [], on: ["auth.user_registered"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[module] eager = true keeps the module's entries eager; the app's hooks stay lazy", async () => {
    const dir = await shopWithAuth({ "hooks.ts": APP_HOOKS }, { "hooks.ts": AUTH_HOOKS, "module.toml": AUTH_TOML.replace('version = "1.0.0"', 'version = "1.0.0"\neager = true') });
    try {
      const e = (await buildFiles(dir)).manifest.entries ?? {};
      expect(e["modules/auth/services"]).toEqual({ exports: ["currentUser"] });
      expect(e["modules/auth/hooks"]?.eager).toBeUndefined();
      expect(e["modules/auth/hooks"]?.on).toEqual(["org.created", "org.member_added"]);
      expect(e.hooks?.eager).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("RENOX_BUILD_EAGER=1 builds the 1.8 shape", async () => {
    const dir = await shopWithAuth({ "hooks.ts": APP_HOOKS }, { "hooks.ts": AUTH_HOOKS });
    process.env.RENOX_BUILD_EAGER = "1";
    try {
      const e = (await buildFiles(dir)).manifest.entries ?? {};
      expect(e["modules/auth/services"]).toEqual({ exports: ["currentUser"] });
      expect(e["modules/auth/hooks"]).toEqual({ exports: ["hooks", "on"] });
      expect(e.hooks).toEqual({ exports: ["on"] });
    } finally {

      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hooks.ts with keys that cannot be read does not build", async () => {
    const dir = await shopWithAuth({}, { "hooks.ts": "const k = 'x.y';\nexport const on = { [k]: async () => {} };\n" });
    try {
      const e = await buildFiles(dir).catch((x: Error) => x);
      expect(e).toBeInstanceOf(BuildError);
      expect((e as Error).message).toContain("hooks.ts");
      expect((e as Error).message).toContain("cannot be read statically");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
