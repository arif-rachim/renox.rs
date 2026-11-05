// Chapter 3: the board page renders the loader's tasks through the partial.
import { describe, expect, test } from "bun:test";
import type { TestApp } from "@renoxium/sdk/test";

// `renox test` sets RENOX_TEST_SPEC; any other `bun test` skips this file.
const run = process.env.RENOX_TEST_SPEC !== undefined;
const t = run ? await (await import("@renoxium/sdk/test")).app() : ({} as TestApp);

describe.skipIf(!run)("the board", () => {
  test("lists the tasks, open ones first", async () => {
    const page = await t.page("/board");
    expect(page.status).toBe(200);
    expect(page.html).toContain("2 open");
    expect(page.html.indexOf("Invite the team")).toBeLessThan(page.html.indexOf("Install the renox CLI"));
    expect(page.html).toContain('<article class="task done">');
  });
});
