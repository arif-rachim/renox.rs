// #235: `renox build` of an app with installed modules: an artifact 1.1
// (docs/contracts/artifact.md, "Modules") that packages/artifact-validate
// accepts (V17-V22), route collisions after mounting, and override drift
// (docs/23-failure-modes.md, "Template override drifted").

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkArtifactFiles } from "@renox/artifact-validate";

import { addModule } from "../src/commands/add.ts";
import { check, securityOutput } from "../src/commands/check.ts";
import { buildArtifact, buildFiles } from "../src/lib/build.ts";
import { unifiedDiff } from "../src/lib/modules/build.ts";
import { dbDts } from "../src/lib/types/generate.ts";
import { LOGIN_HTML, shopWithAuth, write } from "./shop-auth-fixture.ts";
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

  test("approved module csp sources are merged once into security.csp (#660)", async () => {
    const dir = await shopWithAuth();
    await installPay(dir);
    // Without a [security] table the artifact still carries the merged policy.
    const plain = await buildFiles(dir);
    expect(plain.manifest.security).toEqual({ csp: { script_src: ["https://js.psp.example"], frame_src: ["https://*.psp.example", "https://js.psp.example"] } });
    // With the app's own sources: the union, sorted, the shared source once.
    const toml = join(dir, "renox.toml");
    writeFileSync(toml, `${readFileSync(toml, "utf8")}\n[security.csp]\nscript_src = ["https://js.psp.example", "https://analytics.example"]\nreport_only = true\n`);
    const both = await buildFiles(dir);
    expect(both.manifest.security?.csp?.script_src).toEqual(["https://analytics.example", "https://js.psp.example"]);
    expect(both.manifest.security?.csp?.frame_src).toEqual(["https://*.psp.example", "https://js.psp.example"]);
    expect(both.manifest.security?.csp?.report_only).toBe(true);
    expect(checkArtifactFiles(both.files).violations).toEqual([]);
    // renox check --security says where each source comes from.
    const report = securityOutput(dir);
    expect(report).toContain("script-src https://analytics.example  (app)");
    expect(report).toContain("script-src https://js.psp.example  (app, pay)");
    expect(report).toContain("frame-src https://*.psp.example  (pay)");
    expect(report).toContain("script-src 'self' 'nonce-<per-request>' https://analytics.example https://js.psp.example");
  });

  test("a module that brings a directive past 32 sources fails the build naming the module (#660)", async () => {
    const dir = await shopWithAuth();
    const hosts = (prefix: string) => Array.from({ length: 20 }, (_, i) => `"https://${prefix}${i}.example"`).join(", ");
    const toml = join(dir, "renox.toml");
    writeFileSync(toml, `${readFileSync(toml, "utf8")}\n[security.csp]\nimg_src = [${hosts("app")}]\n`);
    await installPay(dir, `csp = { img_src = [${hosts("pay")}] }`);
    const e = await buildFiles(dir).catch((x: Error) => x);
    expect((e as Error).message).toContain("module CSP sources do not merge");
    expect(JSON.stringify(e)).toContain("module pay: its permissions.csp.img_src brings security.csp.img_src to 40 sources; at most 32");
  });
});

/** A `pay` module with `csp` (default: script and frame sources), installed and approved with `renox add --yes`. */
async function installPay(dir: string, csp = 'csp = { script_src = ["https://js.psp.example"], frame_src = ["https://js.psp.example", "https://*.psp.example"] }'): Promise<void> {
  write(join(dir, "modules/pay"), { "module.toml": `[module]\nname = "pay"\nversion = "1.0.0"\n\n[permissions]\n${csp}\n` });
  const log = console.log;
  console.log = () => {};
  try {
    await addModule(dir, "pay", { source: "path:modules/pay", yes: true }, async () => true);
  } finally {
    console.log = log;
  }
}

test("a module csp changed after approval does not build, and its sources stay out of the policy (MF12, #660)", async () => {
  const dir = await shopWithAuth();
  await installPay(dir);
  const toml = join(dir, "modules/pay/module.toml");
  writeFileSync(toml, readFileSync(toml, "utf8").replace('script_src = ["https://js.psp.example"]', 'script_src = ["https://js.psp.example", "https://evil.example"]'));
  const e = await buildFiles(dir).catch((x: Error) => x);
  expect((e as Error).message).toContain("MF12: pay/module.toml: its [permissions] differ from what renox.lock approved");
});

test("a module whose permissions are not the approved ones does not build (MF12, V22)", async () => {
  const dir = await shopWithAuth();
  // auth now asks for a host the app never approved.
  const toml = join(dir, "modules/auth/module.toml");
  writeFileSync(toml, readFileSync(toml, "utf8").replace('tables = "auth__*"', 'tables = "auth__*"\nnetwork = ["accounts.google.com"]'));
  const e = await buildFiles(dir).catch((x: Error) => x);
  expect((e as Error).message).toContain("MF12: auth/module.toml: its [permissions] differ from what renox.lock approved");
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
