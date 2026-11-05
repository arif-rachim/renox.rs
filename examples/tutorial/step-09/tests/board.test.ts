// Chapter 9: one flow per role, on the local worker with a fresh database.
// An owner, a member invited by email, and an outsider in another team.
import { describe, expect, test } from "bun:test";
import type { TestApp } from "@renoxium/sdk/test";

// `renox test` sets RENOX_TEST_SPEC; any other `bun test` skips this file.
const run = process.env.RENOX_TEST_SPEC !== undefined;
const sdk = run ? await import("@renoxium/sdk/test") : null;
const t = sdk ? await sdk.app() : ({} as TestApp);

const PASSWORD = "correct horse battery";

/** The page's <main>: the header carries the team's random id, which changes on every run. */
const main = (html: string): string => html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);

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

/** The invitation link the outbox module kept for this address. */
const invitation = (email: string): string => new URL(t.db.query<{ url: string }>("select url from outbox__mail where mail_to = ? order by id desc limit 1", [email])[0]?.url as string).pathname;

describe.skipIf(!run)("the board, per role", () => {
  let lina: TestApp;
  let omar: TestApp;

  test("signed out: the guard refuses the board", async () => {
    expect((await t.page("/board")).status).toBe(403);
  });

  test("owner: creates the team, adds, ticks off and removes tasks", async () => {
    lina = await signUp("Lina");
    expect((await lina.page("/board")).html).toContain("You are not in a team yet.");
    expect((await lina.action("/org", "create", { name: "Acme" })).status).toBe(303);
    await lina.action("/board", "add", { title: "Write the tutorial" });
    await lina.action("/board", "add", { title: "Ship <b>it</b>" });
    // An htmx request gets the tasks fragment only, not the whole page.
    const fragment = await lina.request("POST", "/board?/add", {
      headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": lina.cookie("__Host-renox_csrf") ?? "", "hx-request": "true", "hx-target": "tasks" },
      body: "title=Plan+the+demo",
    });
    expect(fragment.status).toBe(200);
    expect(fragment.html).toStartWith('<section id="tasks"');
    expect(fragment.html).toContain("3 open");
    expect((await lina.action("/board", "add", { title: "   " })).html).toContain("Write what needs doing.");
    await lina.action("/board", "toggle", { task: taskId("Write the tutorial") });
    await lina.action("/board", "remove", { task: taskId("Plan the demo") });
    const page = await lina.page("/board");
    expect(page.html).toContain("Ship &lt;b&gt;it&lt;/b&gt;");
    expect(page.html).toContain("1 open");
    expect(page.html).toContain(">Remove</button>");
    sdk?.snapshot(main(page.html), { role: "owner" });
  });

  test("member: joins by invitation, adds and ticks off, cannot remove", async () => {
    await lina.action("/org/members", "invite", { email: "omar@example.com", role: "member" });
    omar = await signUp("Omar");
    expect((await omar.action(invitation("omar@example.com"), "accept", {})).status).toBe(303);
    await omar.action("/board", "add", { title: "Review chapter 9" });
    await omar.action("/board", "toggle", { task: taskId("Ship <b>it</b>") });
    const page = await omar.page("/board");
    expect(page.html).toContain("Review chapter 9");
    expect(page.html).not.toContain(">Remove</button>");
    // The button is hidden, and the action refuses the request too.
    expect((await omar.action("/board", "remove", { task: taskId("Review chapter 9") })).status).toBe(403);
    sdk?.snapshot(main(page.html), { role: "member" });
  });

  test("outsider: another team sees none of it and cannot change it", async () => {
    const sara = await signUp("Sara");
    await sara.action("/org", "create", { name: "Other" });
    const page = await sara.page("/board");
    expect(page.html).toContain("Nothing to do yet.");
    expect(page.html).not.toContain("Review chapter 9");
    expect((await sara.action("/board", "toggle", { task: taskId("Review chapter 9") })).status).toBe(404);
  });

  test("live: a member's feed hears about the owner's change", async () => {
    const feed = await omar.sse("/sse/board");
    await Bun.sleep(200);
    await lina.action("/board", "add", { title: "Seen live" });
    const event = await feed.next(5000);
    expect(event?.data).toContain("app__tasks");
    feed.close();
  });
});
