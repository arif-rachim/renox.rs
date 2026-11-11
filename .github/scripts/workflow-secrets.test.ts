import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const script = join(import.meta.dir, "workflow-secrets.ts");
const fixtures = join(import.meta.dir, "fixtures/workflow-secrets");

async function run(dir?: string) {
  const p = Bun.spawn(["bun", script, ...(dir ? [dir] : [])], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe("workflow-secrets", () => {
  for (const [dir, rule, where] of [
    ["set-x", "set-x", "bad.yml:11"],
    ["echo", "echo", "bad.yml:12"],
    ["inline", "inline", "bad.yml:9"],
    ["script-set-x", "set-x", "publish.sh:2"],
  ] as const) {
    test(`${dir} fails naming rule ${rule}`, async () => {
      const { err, code } = await run(join(fixtures, dir));
      expect(code).toBe(1);
      expect(err).toContain(where);
      expect(err).toMatch(new RegExp(`:\\d+: ${rule}:`));
    });
  }

  test("clean passes", async () => {
    const { code, err } = await run(join(fixtures, "clean"));
    expect(err).toBe("");
    expect(code).toBe(0);
  });

  test("the repository workflows pass", async () => {
    const { code, err } = await run();
    expect(err).toBe("");
    expect(code).toBe(0);
  });
});
