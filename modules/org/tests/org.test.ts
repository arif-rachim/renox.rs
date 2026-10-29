// The org module on the real worker (`renox test` in modules/org, #238):
// organisations, the membership fence between organisations (a service
// check: the authorizer fences tables by module, not rows by organisation,
// so this suite is the fence until F5 `db.scoped`), invitations (single
// use, expiry, the invited email only, the before_invite hook), the last
// owner, the events, and the switcher and members page per role
// (docs/24-threat-model.md F4, "Module reading another module's private
// tables" and "Magic link and reset token replay" for the invitation
// token; docs/11-authorization.md for `scope`).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The SDK helper by path: a module tree has no node_modules (its hash covers every file).
import { app, policyCases, ServiceError, snapshot, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const PASSWORD = "correct horse battery";

/** A signed-in user `name` (`<name>@example.com`) in the jar `name`. */
async function user(name: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name[0]?.toUpperCase() + name.slice(1) })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  return u;
}

const org = (u: TestApp) => u.service("org");
const refused = async (p: Promise<unknown>): Promise<ServiceError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ServiceError);
  expect((e as ServiceError).code).toBe("RENOX_MODULE_SERVICE");
  return e as ServiceError;
};

/** The url of the last invitation mailed to `email`. */
const inviteUrl = (email: string): string => {
  const rows = t.db.query<{ url: string }>("select url from orgmail__sent where mail_to = ? order by seq desc limit 1", [email]);
  expect(rows).toHaveLength(1);
  return new URL(rows[0]?.url as string).pathname;
};

/** Events as the orgmail fixture's handlers saw them (in-process, after the commit). */
async function events(name: string, n: number): Promise<{ org_id: string; user_id: string; role: string | null }[]> {
  let rows: { org_id: string; user_id: string; role: string | null }[] = [];
  for (let i = 0; i < 100 && rows.length < n; i++) {
    rows = t.db.query("select org_id, user_id, role from orgmail__events where name = ? order by seq", [name]);
    if (rows.length < n) await Bun.sleep(50);
  }
  return rows;
}

/** Ids are random: stable placeholders, so a snapshot shows only what the role changes. */
const stable = (html: string): string => html.replace(/\b[0-9a-f]{32}\b/gu, "<id>");

const switcherOf = (html: string): string => /<span class="renox-org-switcher">[\s\S]*?<\/span>|<header>[\s\S]*?<\/header>/u.exec(html)?.[0] ?? "";

describe.skipIf(!worker)("org", () => {
  let olive: TestApp;
  let bob: TestApp;
  let ann: TestApp;
  let mo: TestApp;
  let A = "";
  let B = "";

  test("create: the creator is owner, the org is active, scope for the authz context, the events", async () => {
    olive = await user("olive");
    const r = await olive.action("/org", "create", { name: "Acme Trading", slug: "" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/org/members");
    const current = (await org(olive).currentOrg()) as { id: string; slug: string; role: string; scope: unknown };
    A = current.id;
    expect(current.slug).toBe("acme-trading");
    expect(current.role).toBe("owner");
    expect(current.scope).toEqual({ org_id: A, role: "owner" });
    expect(await events("org.created", 1)).toEqual([{ org_id: A, user_id: expect.any(String), role: null }]);
    expect((await events("org.member_added", 1))[0]).toEqual({ org_id: A, user_id: expect.any(String), role: "owner" });
    // The slug is unique.
    expect(await org(olive).createOrg({ name: "Acme Trading" })).toEqual({ error: "That address is taken. Choose another." });
    // Signed out: no current org, and requireMember refuses.
    expect(await org(t.as("nobody")).currentOrg()).toBeNull();
    expect((await refused(org(t.as("nobody")).requireMember())).message).toContain("sign in first");
  });

  test("a member of org A cannot read org B's members, nor act in it", async () => {
    bob = await user("bob");
    const created = (await org(bob).createOrg({ name: "Bob's Bakery" })) as { org: { id: string } };
    B = created.org.id;
    const mine = (await org(olive).members(A)) as { email: string; role: string }[];
    expect(mine.map((m) => [m.email, m.role])).toEqual([["olive@example.com", "owner"]]);
    // Org B's members, its invitations, its roles: refused for olive.
    expect((await refused(org(olive).members(B))).message).toContain("not allowed in this organisation");
    await refused(org(olive).invite({ org: B, email: "x@example.com", role: "member" }));
    const bobId = ((await org(bob).members(B)) as { user_id: string }[])[0]?.user_id as string;
    await refused(org(olive).setRole({ org: B, user: bobId, role: "member" }));
    await refused(org(olive).removeMember({ org: B, user: bobId }));
    await refused(org(olive).revokeInvite({ org: B, invite: "x" }));
    expect(await org(olive).switchOrg(B)).toEqual({ error: "You are not a member of that organisation." });
    // A forged org id in a page's switch: refused, the active org unchanged.
    const forged = await olive.action("/org", "switch", { org: B, next: "/" });
    expect(forged.status).toBe(200);
    expect(forged.html).toContain("You are not a member of that organisation.");
    expect(((await org(olive).currentOrg()) as { id: string }).id).toBe(A);
    // The members page shows the active org only.
    const page = await bob.page("/org/members");
    expect(page.html).toContain('<h1 dir="auto">Bob&#39;s Bakery</h1>');
    expect(page.html).not.toContain("olive@example.com");
    // listOrgs per user.
    const oliveUser = (await olive.service("auth").currentUser()) as { id: string };
    expect(((await org(olive).listOrgs(oliveUser.id)) as { id: string }[]).map((o) => o.id)).toEqual([A]);
  });

  test("invite: one mail, the invited email only, single use; a halting before_invite sends nothing", async () => {
    const r = await olive.action("/org/members", "invite", { email: "Ann@Example.com", role: "admin" });
    expect(r.status).toBe(200);
    expect(r.html).toContain("Invitation sent.");
    expect(r.html).toContain("ann@example.com · admin");
    const path = inviteUrl("ann@example.com");
    expect(path).toMatch(/^\/org\/accept\/[0-9a-f]{64}$/u);
    // Only the hash is stored.
    const token = path.split("/").pop() as string;
    expect(t.db.query("select 1 from org__invites where token_hash = ?", [token])).toEqual([]);
    // Another signed-in user cannot use it.
    const eve = await user("eve");
    expect((await eve.page(path)).status).toBe(200);
    expect((await eve.action(path, "accept", {})).status).toBe(400);
    expect(await org(eve).currentOrg()).toBeNull();
    // Signed out: the login hop, back to the invitation.
    const anon = await t.as("anon-ann").page(path);
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/auth/login?next=${encodeURIComponent(path)}`);
    ann = await user("ann");
    const shown = await ann.page(path);
    expect(shown.html).toContain("You are invited as admin.");
    const accepted = await ann.action(path, "accept", {});
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/org/members");
    expect(((await org(ann).currentOrg()) as { scope: unknown }).scope).toEqual({ org_id: A, role: "admin" });
    // Single use: the same link again, by the same user.
    expect((await ann.action(path, "accept", {})).status).toBe(400);
    expect((await ann.page(path)).status).toBe(400);
    expect((await events("org.member_added", 3)).at(-1)).toEqual({ org_id: A, user_id: expect.any(String), role: "admin" });
    // The hook halts: its response, no invitation, no mail.
    const before = t.db.query("select count(*) as n from orgmail__sent")[0];
    const halted = await olive.action("/org/members", "invite", { email: "x@blocked.example", role: "member" });
    expect(halted.status).toBe(422);
    expect(t.db.query("select count(*) as n from orgmail__sent")[0]).toEqual(before as Record<string, unknown>);
    expect(t.db.query("select 1 from org__invites where email = 'x@blocked.example'")).toEqual([]);
    // A member cannot invite; an admin cannot invite an owner.
    const asMember = await eve.action("/org/members", "invite", { email: "y@example.com", role: "member" });
    expect(asMember.status).toBe(403); // eve is in no organisation
    await refused(org(ann).invite({ org: A, email: "z@example.com", role: "owner" }));
  });

  test("invite expiry and withdrawal", async () => {
    await olive.action("/org/members", "invite", { email: "carl@example.com", role: "member" });
    const expired = inviteUrl("carl@example.com");
    const rw = new Database(t.dbFile);
    rw.exec("pragma busy_timeout = 5000");
    try {
      rw.exec("update org__invites set expires_at = unixepoch() - 1 where email = 'carl@example.com'");
    } finally {
      rw.close();
    }
    // Seven days by default: the row was written with that expiry.
    const carl = await user("carl");
    expect((await carl.page(expired)).status).toBe(400);
    expect((await carl.action(expired, "accept", {})).status).toBe(400);
    expect(await org(carl).currentOrg()).toBeNull();
    // Re-invited, then withdrawn before use.
    await olive.action("/org/members", "invite", { email: "carl@example.com", role: "member" });
    const withdrawn = inviteUrl("carl@example.com");
    const id = t.db.query<{ id: string }>("select id from org__invites where email = 'carl@example.com' and revoked_at is null and accepted_at is null")[0]?.id as string;
    const w = await olive.action("/org/members", "revoke", { invite: id });
    expect(w.html).toContain("Invitation withdrawn.");
    expect((await carl.action(withdrawn, "accept", {})).status).toBe(400);
    // A fresh invitation's lifetime: invite_days (7) from now.
    await olive.action("/org/members", "invite", { email: "carl@example.com", role: "member" });
    const life = t.db.query<{ d: number }>("select expires_at - created_at as d from org__invites where email = 'carl@example.com' and revoked_at is null and accepted_at is null")[0]?.d;
    expect(life).toBe(7 * 86400);
  });

  test("the last owner cannot be removed or demoted; admins never touch an owner; member_removed", async () => {
    const ids = Object.fromEntries(((await org(olive).members(A)) as { user_id: string; email: string }[]).map((m) => [m.email.split("@")[0], m.user_id]));
    const oliveId = ids.olive as string;
    const annId = ids.ann as string;
    expect(await org(olive).removeMember({ org: A, user: oliveId })).toEqual({ error: "An organisation keeps at least one owner: make someone else owner first." });
    expect(await org(olive).setRole({ org: A, user: oliveId, role: "member" })).toEqual({ error: "An organisation keeps at least one owner: make someone else owner first." });
    const leave = await olive.action("/org/members", "leave", {});
    expect(leave.html).toContain("keeps at least one owner");
    // An admin: neither removes nor demotes the owner.
    await refused(org(ann).removeMember({ org: A, user: oliveId }));
    await refused(org(ann).setRole({ org: A, user: oliveId, role: "admin" }));
    await refused(org(ann).setRole({ org: A, user: annId, role: "owner" }));
    // A second owner: now the first may step down.
    expect(await org(olive).setRole({ org: A, user: annId, role: "owner" })).toEqual({ ok: true });
    expect(await org(olive).setRole({ org: A, user: oliveId, role: "admin" })).toEqual({ ok: true });
    expect(await org(ann).setRole({ org: A, user: oliveId, role: "owner" })).toEqual({ ok: true });
    expect(await org(olive).setRole({ org: A, user: annId, role: "admin" })).toEqual({ ok: true });
    // Mo joins as member, then is removed by the admin.
    await olive.action("/org/members", "invite", { email: "mo@example.com", role: "member" });
    mo = await user("mo");
    expect((await mo.action(inviteUrl("mo@example.com"), "accept", {})).status).toBe(303);
    const moId = ((await org(mo).members(A)) as { user_id: string; email: string }[]).find((m) => m.email === "mo@example.com")?.user_id as string;
    await refused(org(mo).requireMember("admin"));
    expect(((await org(mo).requireMember()) as { scope: unknown }).scope).toEqual({ org_id: A, role: "member" });
    expect(await org(ann).removeMember({ org: A, user: moId })).toEqual({ ok: true });
    expect((await events("org.member_removed", 1))[0]).toEqual({ org_id: A, user_id: moId, role: null });
    expect(await org(mo).currentOrg()).toBeNull();
    await refused(org(mo).members(A));
    // Back in, for the snapshots.
    await olive.action("/org/members", "invite", { email: "mo@example.com", role: "member" });
    expect((await mo.action(inviteUrl("mo@example.com"), "accept", {})).status).toBe(303);
  });

  test("switcher and members page per role: owner, admin, member, non-member", async () => {
    const nora = await user("nora");
    // Olive also belongs to org B (a member), to show two entries.
    await bob.action("/org/members", "invite", { email: "olive@example.com", role: "member" });
    expect((await olive.action(inviteUrl("olive@example.com"), "accept", {})).status).toBe(303);
    expect(((await org(olive).currentOrg()) as { id: string }).id).toBe(B);
    // The switcher switches back, then returns to `next`.
    const sw = await olive.action("/org", "switch", { org: A, next: "/" });
    expect(sw.status).toBe(303);
    expect(sw.headers.get("location")).toBe("/");
    // An off-site next is dropped.
    expect((await olive.action("/org", "switch", { org: A, next: "//evil.example/" })).headers.get("location")).toBe("/");
    for (const [role, u] of [
      ["owner", olive],
      ["admin", ann],
      ["member", mo],
      ["non-member", nora],
    ] as const) {
      const home = await u.page("/");
      expect(home.status).toBe(200);
      snapshot(stable(switcherOf(home.html)), { role: `switcher ${role}` });
      const members = await u.page("/org/members");
      if (role === "non-member") {
        expect(members.status).toBe(303);
        expect(members.headers.get("location")).toBe("/org");
        snapshot(stable((await u.page("/org")).html), { role: `orgs ${role}` });
      } else {
        expect(members.status).toBe(200);
        snapshot(stable(members.html), { role: `members ${role}` });
      }
    }
    const owner = switcherOf((await olive.page("/")).html);
    expect(owner).toContain("Acme Trading · owner");
    expect(owner).toContain("Bob&#39;s Bakery · member");
    expect(owner).toContain('href="/org/members"');
    expect(switcherOf((await mo.page("/")).html)).not.toContain('href="/org/members"');
    expect(switcherOf((await nora.page("/")).html)).toContain("Create an organisation");
  });

  test("Arabic (#244): the members page is rtl; the organisation's default applies until a member chooses", async () => {
    const ar = await olive.page("/org/members?lang=ar");
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(ar.html).toContain("<h2>الأعضاء</h2>");
    expect(ar.html).toContain("دورك: مالك");
    snapshot(stable(ar.html), { role: "members owner ar" });
    // Olive's choice is stored for her: no ?lang= next time.
    expect((await olive.page("/org")).html).toContain('<html lang="ar" dir="rtl">');
    // The organisation's default: Arabic for Mo, who has no choice of his own.
    expect((await mo.page("/org/members")).html).toContain('<html lang="en" dir="ltr">');
    const saved = await olive.action("/org/members", "locale", { locale: "ar" });
    expect(saved.html).toContain("Default language saved.");
    expect(((await org(mo).currentOrg()) as { locale: string }).locale).toBe("ar");
    expect((await mo.page("/org/members")).html).toContain('<html lang="ar" dir="rtl">');
    // His own choice wins over the organisation's.
    expect((await mo.page("/org/members?lang=en")).html).toContain('<html lang="en" dir="ltr">');
    expect((await mo.page("/org/members")).html).toContain('<html lang="en" dir="ltr">');
    // A member cannot set it.
    expect((await mo.action("/org/members", "locale", { locale: "en" })).status).toBe(403);
  });

  test("in both digit sets (#266): the members page with ar-u-nu-arab and with plain ar", async () => {
    const arab = await olive.page("/org/members?lang=ar-u-nu-arab");
    expect(arab.html).toContain('<html lang="ar-u-nu-arab" dir="rtl">');
    snapshot(stable(arab.html), { role: "members owner ar-u-nu-arab" });
    const latn = await olive.page("/org/members?lang=ar");
    expect(latn.html).toContain('<html lang="ar" dir="rtl">');
    snapshot(stable(latn.html), { role: "members owner ar latn" });
  });

  test("the public view has the three columns; another module may read it", () => {
    const cols = t.db.query<{ name: string }>("select name from pragma_table_info('org__public_members_v1')").map((c) => c.name);
    expect(cols).toEqual(["org_id", "user_id", "role"]);
  });

  policyCases(join(MODULE, "policies", "tests"));
});
