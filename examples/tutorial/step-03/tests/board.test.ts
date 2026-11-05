// Chapter 3: the board page renders the loader's tasks through the partial.
import { describe, expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

const t = await app();

describe("the board", () => {
  test("lists the tasks, open ones first", async () => {
    const page = await t.page("/board");
    expect(page.status).toBe(200);
    expect(page.html).toContain("2 open");
    expect(page.html.indexOf("Invite the team")).toBeLessThan(page.html.indexOf("Install the renox CLI"));
    expect(page.html).toContain('<article class="task done">');
  });
});
