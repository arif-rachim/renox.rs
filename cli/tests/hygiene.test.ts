// Bundle hygiene at build (#115): forbidden files never reach the artifact,
// a secret in a handler fails `renox build` with file and line, and
// `renox-allow-secret: <reason>` lets it pass. Proves docs/24-threat-model.md
// section B, "Secrets in bundle", and section C, "dotfiles under public/".
//
// The fake key is assembled at run time, so no file of the repository holds
// a string a secret scanner would take for a real key.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../src/commands/check.ts";
import { BuildError, buildArtifact } from "../src/lib/build.ts";
import { testWorker } from "./worker-env.ts";

const repo = join(import.meta.dir, "../..");
const main = join(import.meta.dir, "../src/main.ts");
/** Building examples/shop transpiles its templates with renox-worker (#43). */
const worker = testWorker();
const FAKE_STRIPE = ["sk", "_live_", "51FAKEfakeFAKEfake0123456789abcd"].join("");

/** examples/hello copied to a temp folder (with its node_modules link), changed by `edit`. */
function project(name: string, edit: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), `renox-hygiene-${name}-`));
  cpSync(join(repo, "examples/hello"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("_spike") });
  edit(dir);
  return dir;
}

function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...filesUnder(dir, r));
    else out.push(r);
  }
  return out.sort();
}

function run(dir: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", main, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

const handler = (line: string) => `import type { Handler } from "renox";\n\nconst stripe = "${FAKE_STRIPE}";${line}\nexport const GET: Handler = () => Response.json({ n: stripe.length });\n`;

describe("forbidden files", () => {
  test(".env, .git/, a symlink and id_rsa never reach the artifact (artifact listing)", async () => {
    const dir = project("files", (d) => {
      writeFileSync(join(d, ".env"), "STRIPE_KEY=x\n");
      mkdirSync(join(d, ".git"));
      writeFileSync(join(d, ".git", "config"), "[core]\n");
      writeFileSync(join(d, "id_rsa"), "not a key\n");
      mkdirSync(join(d, "public/.well-known"), { recursive: true });
      mkdirSync(join(d, "public/.git"), { recursive: true });
      writeFileSync(join(d, "public/style.css"), "body{}\n");
      writeFileSync(join(d, "public/.well-known/security.txt"), "Contact: mailto:security@example.com\n");
      writeFileSync(join(d, "public/.env.production"), "X=1\n");
      writeFileSync(join(d, "public/.git/HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(d, "public/id_rsa"), "not a key\n");
      writeFileSync(join(d, "public/server.pem"), "not a cert\n");
      writeFileSync(join(d, "public/app.db"), "");
      writeFileSync(join(d, "public/big.bin"), new Uint8Array(5 * 1024 * 1024 + 1));
      symlinkSync(join(d, ".env"), join(d, "public/config.txt"));
    });
    const out = mkdtempSync(join(tmpdir(), "renox-hygiene-out-"));
    const r = await buildArtifact(dir, out);
    const listing = filesUnder(r.dir);
    // Artifact v1: the public index is public.json at the root (#43).
    expect(listing.filter((p) => p.startsWith("public/"))).toEqual(["public/.well-known/security.txt", "public/style.css"]);
    expect(listing).toContain("public.json");
    for (const p of listing) expect(p).not.toMatch(/(^|\/)(\.env|\.git|id_rsa|config\.txt|server\.pem|app\.db|big\.bin)/u);
    expect(r.skipped.map((s) => s.path).sort()).toEqual(
      ["public/.env.production", "public/.git/", "public/app.db", "public/big.bin", "public/config.txt", "public/id_rsa", "public/server.pem"].sort(),
    );
    expect(r.skipped.find((s) => s.path === "public/config.txt")?.reason).toBe("a symbolic link");

    // `renox build` prints what it left out; `renox check` warns.
    const cli = run(dir, ["build", "--out", mkdtempSync(join(tmpdir(), "renox-hygiene-out2-"))]);
    expect(cli.code).toBe(0);
    expect(cli.stderr).toContain("skipped public/.env.production: an environment file");
    const c = await check(dir);
    expect(c.findings.filter((f) => f.rule === "forbidden-file").map((f) => f.file)).toContain("public/id_rsa");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("secret scan", () => {
  test("a fake sk_live_ key in a handler fails renox build with file and line", async () => {
    const dir = project("secret", (d) => writeFileSync(join(d, "functions/api/pay.ts"), handler("")));
    const err = await buildArtifact(dir, mkdtempSync(join(tmpdir(), "renox-hygiene-out-")), undefined, { secrets: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildError);
    expect(err).toMatchObject({ file: "functions/api/pay.ts", line: 3, column: 17 });
    expect((err as BuildError).message).toContain("stripe-live-key");
    expect((err as BuildError).message).not.toContain(FAKE_STRIPE);

    const cli = run(dir, ["build"]);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain("functions/api/pay.ts:3:17");
    expect(cli.stderr).toContain("renox secrets set");
    expect(cli.stderr + cli.stdout).not.toContain(FAKE_STRIPE);
    expect(readdirSync(dir)).not.toContain(".renox"); // nothing was written

    // `renox dev` builds without the scan; `renox check --secrets` reports it.
    expect((await buildArtifact(dir, mkdtempSync(join(tmpdir(), "renox-hygiene-out-")))).hash).toMatch(/^[0-9a-f]{64}$/u);
    const c = await check(dir, { secretsOnly: true });
    expect(c.findings.map((f) => [f.rule, f.file, f.line, f.severity])).toEqual([["secret", "functions/api/pay.ts", 3, "error"]]);
    const cc = run(dir, ["check", "--secrets"]);
    expect(cc.code).toBe(2);
    expect(cc.stderr).toContain("functions/api/pay.ts:3:17  error  secret");
    rmSync(dir, { recursive: true, force: true });
  });

  test("renox-allow-secret with a reason lets it pass and prints the reason", () => {
    const dir = project("allowed", (d) => writeFileSync(join(d, "functions/api/pay.ts"), handler(" // renox-allow-secret: revoked key kept as a parser fixture")));
    const cli = run(dir, ["build"]);
    expect(cli.code).toBe(0);
    expect(cli.stderr).toContain("allowed functions/api/pay.ts:3  stripe-live-key  renox-allow-secret: revoked key kept as a parser fixture");
    expect(run(dir, ["check", "--secrets"]).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a marker without a reason allows nothing", () => {
    const dir = project("noreason", (d) => writeFileSync(join(d, "functions/api/pay.ts"), handler(" // renox-allow-secret")));
    const cli = run(dir, ["build"]);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain("renox-allow-secret needs a reason");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a key in a public/ file and in a project lib module are found; vendored npm code is not scanned", async () => {
    const dir = project("public", (d) => {
      mkdirSync(join(d, "public"), { recursive: true });
      writeFileSync(join(d, "public/app.js"), `const k = "${FAKE_STRIPE}";\n`);
      mkdirSync(join(d, "lib"));
      writeFileSync(join(d, "lib/keys.ts"), `export const stripeKey = "${FAKE_STRIPE}";\n`);
      writeFileSync(join(d, "functions/api/pay.ts"), `import { stripeKey } from "../../lib/keys.ts";\nexport const GET = () => new Response(String(stripeKey.length));\n`);
    });
    const c = await check(dir, { secretsOnly: true });
    expect(c.findings.map((f) => [f.file, f.line])).toEqual([
      ["lib/keys.ts", 1],
      ["public/app.js", 1],
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  // examples/shop has templates since #45: `renox-worker transpile` compiles them (#43).
  test.skipIf(!worker)("examples/shop, which vendors the Stripe SDK, passes the scan", async () => {
    const r = await buildArtifact(join(repo, "examples/shop"), mkdtempSync(join(tmpdir(), "renox-hygiene-shop-")), undefined, { secrets: true });
    expect(r.allowedSecrets).toEqual([]);
    expect((await check(join(repo, "examples/shop"), { secretsOnly: true })).findings).toEqual([]);
  });
});
