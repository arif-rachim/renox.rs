// Chapter 8: the team's feed hears every change of its tasks.
import { describe, expect, test } from "bun:test";
import { app, type TestApp } from "@renoxium/sdk/test";

const t = await app();

const PASSWORD = "correct horse battery";

/** A new user, registered and signed in, with their own cookies. */
async function signUp(name: string): Promise<TestApp> {
  const u = t.as(name);
  const email = `${name.toLowerCase()}@example.com`;
  await u.action("/auth/register", "default", { email, password: PASSWORD, display_name: name });
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD })).status).toBe(303);
  return u;
}

/** The id of the task with this title. */
const taskId = (title: string): string => String(t.db.query<{ id: number }>("select id from app__tasks where title = ?", [title])[0]?.id);

describe("the board, per team", () => {
  test("signed out: the guard refuses the board", async () => {
    expect((await t.page("/board")).status).toBe(403);
  });

  test("a new user creates a team, then adds and ticks off its tasks", async () => {
    const lina = await signUp("Lina");
    expect((await lina.page("/board")).html).toContain("You are not in a team yet.");
    expect((await lina.action("/org", "create", { name: "Acme" })).status).toBe(303);
    await lina.action("/board", "add", { title: "Write the tutorial" });
    await lina.action("/board", "toggle", { task: taskId("Write the tutorial") });
    const page = await lina.page("/board");
    expect(page.html).toContain("ACME");
    expect(page.html).toContain('<article class="task done">');
  });

  test("another team sees none of it and cannot change it", async () => {
    const sara = await signUp("Sara");
    await sara.action("/org", "create", { name: "Other" });
    expect((await sara.page("/board")).html).not.toContain("Write the tutorial");
    expect((await sara.action("/board", "toggle", { task: taskId("Write the tutorial") })).status).toBe(404);
  });

  test("live: the feed of a team hears its changes, and only its own", async () => {
    const lina = t.as("Lina");
    const sara = t.as("Sara");
    const linaFeed = await lina.sse("/sse/board");
    const saraFeed = await sara.sse("/sse/board");
    await Bun.sleep(200);
    await lina.action("/board", "add", { title: "Seen live" });
    expect((await linaFeed.next(5000))?.data).toContain("app__tasks");
    expect(await saraFeed.next(500)).toBeNull();
    linaFeed.close();
    saraFeed.close();
  });
});
