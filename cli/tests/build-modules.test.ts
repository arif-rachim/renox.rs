// #235: `renox build` of an app with installed modules: an artifact 1.1
// (docs/contracts/artifact.md, "Modules") that packages/artifact-validate
// accepts (V17-V22), route collisions after mounting, and override drift
// (docs/23-failure-modes.md, "Template override drifted").

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkArtifactFiles } from "@renox/artifact-validate";

import { check } from "../src/commands/check.ts";
import { buildArtifact, buildFiles } from "../src/lib/build.ts";
import { unifiedDiff } from "../src/lib/modules/build.ts";
import { dbDts } from "../src/lib/types/generate.ts";
import { LOGIN_HTML, shopWithAuth } from "./shop-auth-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
const out = () => mkdtempSync(join(tmpdir(), "renox-build-modules-"));

describe.skipIf(!worker)("renox build with modules", () => {
  test("shop + auth builds an artifact 1.1 that the shared validator accepts", async () => {
    const dir = await shopWithAuth({ "overrides/auth/pages/login.html": `<main class="shop-login"><h1>Sign in to the shop</h1></main>\n` });
    const r = await buildFiles(dir);
    const result = checkArtifactFiles(r.files);
    expect(result.violations).toEqual([]);
    const m = r.manifest;
    // Code under code/modules/auth/, routes under the mount.
    expect(Object.keys(m.code.entry).sort()).toEqual(["functions/api/health", "modules/auth/functions/logout", "modules/auth/pages/login", "modules/auth/services"]);
    expect(r.files.has("code/modules/auth/services.js")).toBe(true);
    expect(m.routes).toContainEqual({ kind: "page", path: "/auth/login", module: "modules/auth/pages/login", load: true, template: "modules/auth/pages/login" });
    expect(m.routes).toContainEqual({ kind: "function", method: "POST", path: "/auth/logout", module: "modules/auth/functions/logout", export: "POST" });
    // The modules field from the lock; exports for the broker.
    expect(m.modules?.map((x) => x.name)).toEqual(["auth"]);
    const auth = m.modules?.[0] as Record<string, unknown>;
    expect(auth.mount).toBe("/auth");
    expect(auth.exports).toEqual({ services: ["currentUser"], events: { "auth.user_registered": { type: "object", required: ["user_id"], properties: { user_id: { type: "string" } } } }, hooks: [], views: ["auth__public_users_v1"] });
    // Migrations per module, the app's as `app`, all in checksums.json.
    const sums = JSON.parse(new TextDecoder().decode(r.files.get("migrations/checksums.json"))) as { files: Record<string, string> };
    expect(Object.keys(sums.files)).toEqual(["app/001_init.sql", "auth/001_users.sql"]);
    // Slots registry and the compiled include in the app layout.
    expect(m.slots).toEqual({ "app.header": [{ module: "auth", template: "modules/auth/partials/menu" }] });
    expect(r.templates["pages/_layouts/main"]?.source).toContain(`{% include "modules/auth/partials/menu" %}`);
    // The override is compiled into auth's template id, carried with its original's hash.
    expect(r.templates["modules/auth/pages/login"]?.source).toContain("shop-login");
    const idx = JSON.parse(new TextDecoder().decode(r.files.get("overrides.json"))) as { files: Record<string, { template: string; original_sha256: string }> };
    expect(idx.files["auth/pages/login.html"]?.template).toBe("modules/auth/pages/login");
    expect(idx.files["auth/pages/login.html"]?.original_sha256).toBe(new Bun.CryptoHasher("sha256").update(LOGIN_HTML).digest("hex"));
    expect(r.drift).toEqual([]);
  });

  test("a module route colliding with an app route is rejected naming both", async () => {
    const dir = await shopWithAuth({ "functions/auth/logout.ts": `export function POST() { return new Response("app"); }\n` });
    const e = await buildFiles(dir).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain("V21");
    expect((e as Error).message).toContain("the app and module auth");
  });

  test("an override whose original changed is reported with a diff; --strict fails", async () => {
    const dir = await shopWithAuth({ "overrides/auth/pages/login.html": `<main class="shop-login"><h1>Sign in</h1></main>\n` });
    const first = await buildArtifact(dir, out());
    expect(first.drift).toEqual([]);
    // The override index is stored in the app: the original it was made against.
    expect(JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8")).files["auth/pages/login.html"].original_sha256).toHaveLength(64);
    // Upgrade auth: its login template changes.
    writeFileSync(join(dir, "modules/auth/pages/login.html"), `<main class="auth-login"><h1>Sign in</h1><p>Magic link</p></main>\n`);
    const { addModule } = await import("../src/commands/add.ts");
    const log = console.log;
    console.log = () => {};
    await addModule(dir, "auth", { source: "path:modules/auth", yes: true }, async () => true);
    console.log = log;
    const second = await buildArtifact(dir, out());
    expect(second.drift).toHaveLength(1);
    expect(second.drift[0]?.file).toBe("auth/pages/login.html");
    expect(second.drift[0]?.diff).toContain("+<main class=\"auth-login\"><h1>Sign in</h1><p>Magic link</p></main>");
    expect(second.drift[0]?.diff).toContain("-<main class=\"shop-login\"><h1>Sign in</h1></main>");
    const warn = await check(dir);
    expect(warn.findings.filter((f) => f.rule === "override-drift").map((f) => f.severity)).toEqual(["warning"]);
    const strict = await check(dir, { strict: true });
    expect(strict.findings.filter((f) => f.rule === "override-drift").map((f) => f.severity)).toEqual(["error"]);
  });
});

test("db.d.ts has the module tables, grouped by prefix", async () => {
  const dir = await shopWithAuth();
  const dts = dbDts(dir);
  expect(dts).toContain(`"auth__users": {`);
  expect(dts).toContain(`"app__orders": {`);
  expect(dts).toContain("export type TablesOf<P extends string>");
});

test("unified diff", () => {
  expect(unifiedDiff("a\nb\nc", "a\nB\nc", "x", "y")).toBe("--- x\n+++ y\n a\n+B\n-b\n c\n");
});
