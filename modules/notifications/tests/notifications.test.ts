// The notifications module on the real worker (#289): notify updates the
// badge and the list of a connected user and of no one else (two SSE
// clients); a subscribe to another user's topic is refused
// (docs/24-threat-model.md "Subscribing to another user's topic"); prefs
// stop a channel; unread count and mark read; snapshots in English and
// Arabic.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, snapshot, type SseStream, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const PASSWORD = "correct horse battery";

async function user(name: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  return u;
}

const idOf = (name: string): string => t.db.query<{ id: string }>("select id from auth__users where email = ?", [`${name}@example.com`])[0]?.id as string;
const notify = (userId: string, item: Record<string, unknown>) => t.request("POST", "/api/notify", { body: { user: userId, item } });
const stable = (html: string): string => html.replace(/\bntf_[0-9a-z]+\b/gu, "<ntf>").replace(/\b[0-9a-f]{32}\b/gu, "<id>");

/** Events until `name` arrives (keep-alives aside), or null. */
async function until(s: SseStream, name: string, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) return null;
    const e = await s.next(left);
    if (e === null || e.event === name) return e;
  }
}

describe.skipIf(!worker)("notifications", () => {
  let alice: TestApp;
  let bob: TestApp;

  test("two SSE clients: notify reaches alice's badge and list, never bob's; another user's topic is refused", async () => {
    alice = await user("alice");
    bob = await user("bob");
    const a = await alice.sse("/notifications/sse/notifications");
    const b = await bob.sse("/notifications/sse/notifications");
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toContain("text/event-stream");
    expect(b.status).toBe(200);
    // bob tries alice's topic through an app route: the policy refuses it, the stream ends.
    const spy = await bob.sse(`/sse/spy?user=${idOf("alice")}`);
    const r = await notify(idOf("alice"), { category: "orders", title: "Order #42 shipped", body: "On its way", link: "/orders/42" });
    expect(r.status).toBe(200);
    expect(r.json<{ channels: string[] }>().channels).toEqual(["inapp", "whatsapp"]);
    const badge = await until(a, "notif-badge");
    expect(badge?.data).toContain('id="notif-count"');
    expect(badge?.data).toContain(">1</span>");
    const item = await until(a, "notif-item");
    expect(item?.data).toContain("Order #42 shipped");
    expect(item?.data).toContain('href="/orders/42"');
    expect(await b.next(700)).toBeNull();
    expect(await spy.next(700)).toBeNull();
    // A signed-out connection gets nothing either (open throws, the stream ends).
    const anon = await t.as("anon").sse("/notifications/sse/notifications");
    expect(await anon.next(500)).toBeNull();
    a.close();
    b.close();
    spy.close();
    anon.close();
  });

  test("unread count, the badge in the header, mark read over the page (the badge follows live)", async () => {
    expect(await alice.service("notifications").unreadCount()).toBe(1);
    const home = await alice.page("/");
    expect(home.html).toContain('class="renox-notif-badge" href="/notifications"');
    expect(home.html).toContain('sse-connect="/notifications/sse/notifications"');
    expect(home.html).toMatch(/id="notif-count"[^>]*>1<\/span>/u);
    // Signed out: no badge.
    expect((await t.as("nobody").page("/")).html).not.toContain("renox-notif-badge");
    const live = await alice.sse("/notifications/sse/notifications");
    const list = await alice.page("/notifications");
    expect(list.status).toBe(200);
    snapshot(stable(list.html), { role: "list en" });
    const id = t.db.query<{ id: string }>("select id from notifications__items where title = 'Order #42 shipped'")[0]?.id as string;
    const read = await alice.action("/notifications", "read", { id });
    expect(read.status).toBe(200);
    expect((await until(live, "notif-badge"))?.data).toContain(">0</span>");
    expect(await alice.service("notifications").unreadCount()).toBe(0);
    // bob cannot mark alice's notification: the scoped update touches none of his rows.
    expect(await bob.service("notifications").markRead(id)).toBe(false);
    live.close();
    // Signed out: the list sends to the login page.
    const anon = await t.as("anon2").page("/notifications");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toStartWith("/auth/login?next=");
  });

  test("prefs stop a channel: whatsapp off for orders, then in-app off too", async () => {
    const before = t.db.query<{ n: number }>("select count(*) as n from deliver__sent where user_id = ?", [idOf("alice")])[0]?.n as number;
    expect(before).toBe(1);
    const prefs = await alice.page("/notifications/prefs");
    expect(prefs.html).toContain(">orders</code>");
    snapshot(stable(prefs.html), { role: "prefs en" });
    expect((await alice.action("/notifications/prefs", "set", { category: "orders", channel: "whatsapp", enabled: "0" })).status).toBe(200);
    const r1 = await notify(idOf("alice"), { category: "orders", title: "Order #43 shipped" });
    expect(r1.json<{ channels: string[] }>().channels).toEqual(["inapp"]);
    expect(t.db.query<{ n: number }>("select count(*) as n from deliver__sent where user_id = ?", [idOf("alice")])[0]?.n).toBe(before);
    // Other categories still go out on WhatsApp.
    expect((await notify(idOf("alice"), { category: "billing", title: "Invoice ready" })).json<{ channels: string[] }>().channels).toEqual(["inapp", "whatsapp"]);
    // In-app off: no row, no badge event.
    await alice.action("/notifications/prefs", "set", { category: "orders", channel: "inapp", enabled: "0" });
    const live = await alice.sse("/notifications/sse/notifications");
    const r2 = await notify(idOf("alice"), { category: "orders", title: "Order #44 shipped" });
    expect(r2.json<{ id: string | null; channels: string[] }>()).toEqual({ id: null, channels: [] });
    expect(t.db.query("select 1 from notifications__items where title = 'Order #44 shipped'")).toEqual([]);
    expect(await until(live, "notif-badge", 700)).toBeNull();
    live.close();
    // bob's preferences are his own.
    expect(((await bob.service("notifications").preferences()) as unknown[]).length).toBe(0);
  });

  test("bad input is refused; a link is a path of the app or https", async () => {
    expect((await notify(idOf("bob"), { category: "Bad Category", title: "x" })).status).toBe(500);
    await notify(idOf("bob"), { category: "misc", title: "Click", link: "javascript:alert(1)" });
    await notify(idOf("bob"), { category: "misc", title: "Elsewhere", link: "//evil.example/x" });
    expect(t.db.query("select link from notifications__items where user_id = ? order by created_at", [idOf("bob")])).toEqual([{ link: "" }, { link: "" }]);
  });

  test("Arabic: lang=ar, dir=rtl, the Arabic catalog", async () => {
    const page = await alice.page("/notifications?lang=ar");
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain("الإشعارات");
    snapshot(stable(page.html), { role: "list ar" });
  });
});
