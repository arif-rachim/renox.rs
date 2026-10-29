// docs/24-threat-model.md, "Open redirect via `next`/`return_to`" (#111):
// `renox check` fails on a handler that redirects to a query parameter,
// naming the file and line (rule no-unsafe-redirect).
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "../..");
const main = join(import.meta.dir, "../src/main.ts");

test("renox check fails with file and line on an unsafe redirect, and passes with redirect.safe", () => {
  const dir = mkdtempSync(join(tmpdir(), "renox-redirect-"));
  try {
    cpSync(join(repo, "examples/hello"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("_spike") });
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(join(repo, "sdk"), join(dir, "node_modules/renox"));
    const handler = (target: string): string =>
      `import { type Ctx, redirect } from "renox";\n\nexport function GET({ url }: Ctx): Response {\n  void redirect;\n  return ${target};\n}\n`;
    writeFileSync(join(dir, "functions/api/next.ts"), handler(`Response.redirect(url.searchParams.get("next") ?? "/")`));
    const bad = Bun.spawnSync(["bun", main, "check"], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
    const stderr = bad.stderr.toString();
    expect(bad.exitCode).not.toBe(0);
    expect(stderr).toMatch(/functions\/api\/next\.ts:5:\d+ {2}error {2}no-unsafe-redirect /u);

    writeFileSync(join(dir, "functions/api/next.ts"), handler(`redirect.safe(url.searchParams.get("next") ?? "/")`));
    const good = Bun.spawnSync(["bun", main, "check"], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
    expect(good.stderr.toString()).not.toContain("no-unsafe-redirect");
    expect(good.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
