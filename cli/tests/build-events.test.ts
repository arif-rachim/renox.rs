// #630 (artifact 1.8): the app's own `hooks.ts` entry, `[[slots]]` fillers
// (module `app`, after a module's filler of equal priority) and
// `[events."app.<name>"]`, written by `renox build` and accepted by the
// shared validator; the rules `renox build` and `renox.toml` apply.

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { mergeSlots } from "../src/lib/modules/build.ts";
import { BuildError, buildFiles } from "../src/lib/build.ts";
import { validate } from "../src/lib/schema.ts";
import { schemas } from "../src/lib/schemas.ts";
import { readProject } from "../src/lib/project.ts";
import { transpile } from "../src/lib/templates-compile.ts";
import { app } from "./authz-fixture.ts";
import { shopWithAuth } from "./shop-auth-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;

const TOML = `[app]
name = "shop"
timezone = "Asia/Dubai"

[[slots]]
name = "app.header"
template = "partials/promo.html"

[[slots]]
name = "app.footer"
template = "partials/footer.html"
priority = 200

[events."app.order_placed"]
description = "An order was placed."
payload = { type = "object", required = ["order_id"], properties = { order_id = { type = "string" } } }
`;

const HOOKS = `export const on = { "auth.user_registered": async (ctx, event) => { await ctx.events.emit("app.order_placed", { order_id: event.payload.user_id }); } };\n`;

describe("mergeSlots", () => {
  test("priority, then module name; the app last on equal priority, whatever its name", () => {
    const merged = mergeSlots(
      [
        { slot: "a.b", module: "zeta", template: "modules/zeta/partials/z", priority: 100 },
        { slot: "a.b", module: "auth", template: "modules/auth/partials/a", priority: 100 },
      ],
      [
        { name: "a.b", template: "partials/mine.html" },
        { name: "a.b", template: "partials/first.html", priority: 5, requires: "doc.read" },
      ],
    );
    expect(merged["a.b"]).toEqual([
      { module: "app", template: "partials/first", requires: "doc.read" },
      { module: "auth", template: "modules/auth/partials/a" },
      { module: "zeta", template: "modules/zeta/partials/z" },
      { module: "app", template: "partials/mine" },
    ]);
  });
});

describe("renox.toml [[slots]] and [events]", () => {
  test("readProject reads them; the manifest key is absent when none are declared", () => {
    const dir = app({ "renox.toml": TOML });
    const none = app({ "renox.toml": `[app]\nname = "x"\ntimezone = "UTC"\n` });
    try {
      const c = readProject(dir);
      expect(c.slots?.map((s) => s.name)).toEqual(["app.header", "app.footer"]);
      expect(Object.keys(c.events ?? {})).toEqual(["app.order_placed"]);
      expect(readProject(none)).not.toHaveProperty("events");
      expect(readProject(none)).not.toHaveProperty("slots");
    } finally {
      for (const d of [dir, none]) rmSync(d, { recursive: true, force: true });
    }
  });

  test.each([
    ["an event without app.", `[events."job.done"]\npayload = { type = "object" }\n`, 'events."job.done"'],
    ["an event without a payload", `[events."app.x"]\ndescription = "d"\n`, "payload is required"],
    ["an unsupported payload keyword", `[events."app.x"]\npayload = { type = "object", dependentRequired = {} }\n`, "unsupported keyword"],
    ["a priority above 1000", `[[slots]]\nname = "a.b"\ntemplate = "partials/p.html"\npriority = 1001\n`, "priority must be an integer from 0 to 1000"],
    ["a template outside partials/", `[[slots]]\nname = "a.b"\ntemplate = "pages/p.html"\n`, "template must be a partial"],
    ["a slot name without a dot", `[[slots]]\nname = "header"\ntemplate = "partials/p.html"\n`, "dotted slot name"],
  ])("%s is a renox.toml error naming the key", (_, extra, needle) => {
    const dir = app({ "renox.toml": `[app]\nname = "x"\ntimezone = "UTC"\n\n${extra}` });
    try {
      expect(() => readProject(dir)).toThrow(needle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!worker)("renox build with hooks.ts, [[slots]] and [events]", () => {
  test("artifact 1.8: the hooks entry, the app fillers after the module's, the events map", async () => {
    const dir = await shopWithAuth({
      "renox.toml": TOML.replace('name = "app.footer"', 'name = "app.header"').replace("priority = 200", "priority = 100"),
      "hooks.ts": HOOKS,
      "partials/promo.html": `<aside>Free shipping</aside>\n`,
      "partials/footer.html": `<small>Footer</small>\n`,
    });
    try {
      const r = await buildFiles(dir);
      const m = r.manifest;
      expect(validate(schemas.manifest, m as never)).toEqual([]);
      expect(m.artifact).toEqual({ version: 1 });
      expect(m.code.entry.hooks).toBe("hooks.js");
      expect(r.files.has("code/hooks.js")).toBe(true);
      expect(m.entries?.hooks?.exports).toEqual(["on"]);
      expect(m.entries?.hooks?.eager).toBeUndefined();
      // Used by no route (V7).
      expect(m.routes.some((x) => (x as { module?: string }).module === "hooks")).toBe(false);
      // The module's filler first, the app's two after it (equal priority: the app last; then 100 < 100 tie by order of declaration).
      expect(m.slots?.["app.header"]).toEqual([
        { module: "auth", template: "modules/auth/partials/menu" },
        { module: "app", template: "partials/promo" },
        { module: "app", template: "partials/footer" },
      ]);
      expect(m.templates?.["partials/promo"]).toEqual({ kind: "partial" });
      expect(m.events).toEqual({
        "app.order_placed": { description: "An order was placed.", payload: { type: "object", required: ["order_id"], properties: { order_id: { type: "string" } } } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an app with hooks.ts and a page, no slots and no events, builds; the manifest has no events key", async () => {
    const dir = app({ "renox.toml": `[app]\nname = "x"\ntimezone = "UTC"\n`, "hooks.ts": HOOKS, "pages/index.html": `<p>hi</p>\n` });
    try {
      const r = await buildFiles(dir);
      expect(Object.keys(r.manifest.code.entry)).toEqual(["hooks"]);
      expect(r.manifest).not.toHaveProperty("events");
      expect(r.manifest).not.toHaveProperty("slots");
      expect(validate(schemas.manifest, r.manifest as never)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a page used as a filler, and a filler that does not exist, fail the build", async () => {
    const files = { "pages/index.html": `<main><r-slot name="app.header" /></main>\n`, "pages/about.html": `<p>About</p>\n`, "hooks.ts": HOOKS };
    const page = app({ ...files, "renox.toml": `[app]\nname = "x"\ntimezone = "UTC"\n\n[[slots]]\nname = "app.header"\ntemplate = "pages/about.html"\n` });
    const missing = app({ ...files, "renox.toml": `[app]\nname = "x"\ntimezone = "UTC"\n\n[[slots]]\nname = "app.header"\ntemplate = "partials/nope.html"\n` });
    try {
      // A page template is refused by the renox.toml rule before it reaches the compiler.
      expect(() => readProject(page)).toThrow("template must be a partial");
      const e = (await buildFiles(missing).catch((x: unknown) => x)) as Error;
      expect(e).toBeInstanceOf(BuildError);
      expect(e.message).toContain("partials/nope.html does not exist");
    } finally {
      for (const d of [page, missing]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("a filler naming a page template in the compiler is refused (the worker's own rule)", async () => {
    const sources = { "pages/index.html": `<main><r-slot name="app.header" /></main>\n`, "pages/about.html": `<p>About</p>\n` };
    await expect(transpile(sources, undefined, { "app.header": [{ template: "pages/about" }] })).rejects.toThrow("not a partial");
  });
});
