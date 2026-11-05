// Chapter 4: the board reads its tasks from SQLite; `renox test` loads
// seeds/tasks.sql into this file's fresh database first.
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

  test("the rows come from the migration's table", () => {
    expect(t.db.query("select count(*) as n from app__tasks")).toEqual([{ n: 3 }]);
  });
});
