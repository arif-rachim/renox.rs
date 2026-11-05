// Chapter 5: the actions add, tick off and remove tasks; an htmx request
// gets the `tasks` fragment only.
import { describe, expect, test } from "bun:test";
import type { TestApp } from "@renoxium/sdk/test";

// `renox test` sets RENOX_TEST_SPEC; any other `bun test` skips this file.
const run = process.env.RENOX_TEST_SPEC !== undefined;
const t = run ? await (await import("@renoxium/sdk/test")).app() : ({} as TestApp);

/** The id of the task with this title. */
const taskId = (title: string): string => String(t.db.query<{ id: number }>("select id from app__tasks where title = ?", [title])[0]?.id);

describe.skipIf(!run)("the board", () => {
  test("lists the seeded tasks, open ones first", async () => {
    const page = await t.page("/board");
    expect(page.html).toContain("2 open");
    expect(page.html.indexOf("Invite the team")).toBeLessThan(page.html.indexOf("Install the renox CLI"));
  });

  test("add: a task, escaped; an empty title is refused", async () => {
    const added = await t.action("/board", "add", { title: "Ship <b>it</b>" });
    expect(added.html).toContain("Ship &lt;b&gt;it&lt;/b&gt;");
    expect(added.html).toContain("3 open");
    expect((await t.action("/board", "add", { title: "   " })).html).toContain("Write what needs doing.");
  });

  test("toggle and remove", async () => {
    await t.action("/board", "toggle", { task: taskId("Invite the team") });
    expect((await t.page("/board")).html).toContain("2 open");
    await t.action("/board", "remove", { task: taskId("Ship <b>it</b>") });
    expect((await t.page("/board")).html).not.toContain("Ship &lt;b&gt;");
    expect((await t.action("/board", "toggle", { task: "999" })).status).toBe(404);
  });

  test("htmx: the fragment only, not the page", async () => {
    const res = await t.request("POST", "/board?/add", {
      headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": t.cookie("__Host-renox_csrf") ?? "", "hx-request": "true", "hx-target": "tasks" },
      body: "title=Plan+the+demo",
    });
    expect(res.status).toBe(200);
    expect(res.html).toStartWith('<section id="tasks"');
    expect(res.html).not.toContain("<html");
  });
});
