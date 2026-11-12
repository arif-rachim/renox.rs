// org.bootstrap (#747): the platform's one-time setup of a new app. The
// guard (anonymous principal, a fresh app, the owner the only user), the
// limits, the organisations, the invitations and their mails, the events.
// The service route runs it on the real worker (anonymous, in a
// transaction); the guard and the limits also run on a ctx over the tenant
// file, to give the other principals (a session, a job, a module, the platform).

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { app, ServiceError, type TestApp } from "../../../sdk/src/test.ts";

// core.ts imports `renox:modules`, which only the worker resolves; bootstrap never calls it.
// Bun keeps a module mock for the rest of the `bun test` process, so it names every
// module the repository's code imports from `renox:modules` (as modules/reports' test does).
mock.module("renox:modules", () => ({ auth: {}, i18n: {}, email: {}, tax_gcc: {}, billing: {} }));
const { bootstrap } = await import("../lib/core.ts");

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;

type Principal = { kind: string; id: string } | null;
type Input = Record<string, unknown>;

/** A fresh app with `n` registered users (`u1@example.com` ...), and their ids. */
async function freshApp(n: number): Promise<{ t: TestApp; ids: string[] }> {
  const t = await app({ project: MODULE });
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const u = t.as(`u${i}`);
    expect((await u.action("/auth/register", "default", { email: `u${i}@example.com`, password: "correct horse battery", display_name: `User ${i}` })).status).toBe(200);
    ids.push(t.db.query<{ id: string }>("select id from auth__users where email = ?", [`u${i}@example.com`])[0]?.id as string);
  }
  return { t, ids };
}

/** The ctx the cell gives org's service, over the tenant file, with `principal`; hook runs and events are recorded. */
function ctxAs(t: TestApp, principal: Principal, opts: { halt?: (email: string) => boolean; url?: string } = {}) {
  const rw = new Database(t.dbFile);
  rw.exec("pragma busy_timeout = 5000");
  const hooks: { name: string; args: { to?: string; email?: string; args?: { url: string; invited_by: string; org_name: string } } }[] = [];
  const events: { name: string; payload: Record<string, unknown> }[] = [];
  type P = SQLQueryBindings[];
  const ctx = {
    principal,
    headers: new Headers(),
    config: {},
    ...(opts.url ? { url: new URL(opts.url) } : {}),
    db: {
      query: async (sql: string, params: P = []) => rw.query(sql).all(...params),
      queryOne: async (sql: string, params: P = []) => rw.query(sql).get(...params) ?? null,
      execute: async (sql: string, params: P = []) => ({ changes: rw.query(sql).run(...params).changes }),
    },
    events: {
      emit: async (name: string, payload: Record<string, unknown>) => {
        events.push({ name, payload });
        return "evt";
      },
    },
    hooks: {
      run: async (name: string, args: { email?: string }) => {
        hooks.push({ name, args: structuredClone(args) });
        if (name === "org.before_invite" && opts.halt?.(args.email ?? "")) return { halt: true, response: new Response("no", { status: 422 }), module: "orgmail" };
        return { halt: false };
      },
    },
  } as unknown as Parameters<typeof bootstrap>[0];
  return { ctx, hooks, events, close: () => rw.close() };
}

const counts = (t: TestApp) => ({
  orgs: t.db.query<{ n: number }>("select count(*) as n from org__orgs")[0]?.n,
  members: t.db.query<{ n: number }>("select count(*) as n from org__members")[0]?.n,
  invites: t.db.query<{ n: number }>("select count(*) as n from org__invites")[0]?.n,
});
const NOTHING = { orgs: 0, members: 0, invites: 0 };

async function run(t: TestApp, principal: Principal, input: unknown, opts: Parameters<typeof ctxAs>[2] = {}) {
  const { ctx, hooks, events, close } = ctxAs(t, principal, opts);
  try {
    const result = await bootstrap(ctx, input as never).then(
      (v) => ({ v }),
      (e: unknown) => ({ e: e as { code?: string; status?: number; details?: unknown; message?: string } }),
    );
    return { ...result, hooks, events };
  } finally {
    close();
  }
}

const REQ = (owner: string, over: Input = {}): Input => ({
  owner_user_id: owner,
  orgs: [{ name: "Dubai Branch" }, { name: "Abu Dhabi", slug: "AUH" }],
  invites: [
    { email: "Tech@Example.com", org_index: 0, role: "member" },
    { email: "boss@example.com", org_index: 1, role: "admin" },
  ],
  ...over,
});

describe.skipIf(!worker)("org.bootstrap (#747)", () => {
  test("creates the organisations, the owner's membership, the invitations, the events and one mail per invitation", async () => {
    const { t, ids } = await freshApp(1);
    const r = await run(t, null, REQ(ids[0] as string), { url: "https://shop.example.test/api/setup" });
    expect(r.e).toBeUndefined();
    const out = r.v as { orgs: { id: string; name: string; slug: string }[]; invitations: { email: string; org_id: string }[] };
    expect(out.orgs.map((o) => [o.name, o.slug])).toEqual([
      ["Dubai Branch", "dubai-branch"],
      ["Abu Dhabi", "auh"],
    ]);
    expect(out.invitations).toEqual([
      { email: "tech@example.com", org_id: out.orgs[0]?.id as string },
      { email: "boss@example.com", org_id: out.orgs[1]?.id as string },
    ]);
    expect(t.db.query("select org_id, user_id, role from org__members order by org_id")).toEqual(
      out.orgs.map((o) => ({ org_id: o.id, user_id: ids[0], role: "owner" })).sort((a, b) => (a.org_id < b.org_id ? -1 : 1)),
    );
    expect(t.db.query("select created_by from org__orgs")).toEqual([{ created_by: ids[0] }, { created_by: ids[0] }]);
    const inv = t.db.query<{ email: string; role: string; invited_by: string; token_hash: string; expires_at: number; created_at: number }>("select * from org__invites order by email");
    expect(inv.map((i) => [i.email, i.role, i.invited_by])).toEqual([
      ["boss@example.com", "admin", ids[0]],
      ["tech@example.com", "member", ids[0]],
    ]);
    for (const i of inv) {
      expect(i.token_hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(i.expires_at - i.created_at).toBe(7 * 86400);
    }
    // No session, so no active organisation.
    expect(t.db.query("select 1 from org__active")).toEqual([]);
    // org.created and org.member_added per organisation, in order.
    expect(r.events.map((e) => e.name)).toEqual(["org.created", "org.member_added", "org.created", "org.member_added"]);
    expect(r.events[1]?.payload).toMatchObject({ org_id: out.orgs[0]?.id, user_id: ids[0], role: "owner" });
    // One before_invite and one send_mail run per invitation, with the accept link on the request's origin.
    expect(r.hooks.filter((h) => h.name === "org.before_invite")).toHaveLength(2);
    const mails = r.hooks.filter((h) => h.name === "org.send_mail");
    expect(mails.map((m) => m.args.to)).toEqual(["tech@example.com", "boss@example.com"]);
    expect(mails[0]?.args.args).toMatchObject({ invited_by: "User 1", org_name: "Dubai Branch" });
    expect(mails[0]?.args.args?.url).toMatch(/^https:\/\/shop\.example\.test\/org\/accept\/[0-9a-f]{64}$/u);
  });

  test("without a request url the accept link is the app path; two orgs named alike get distinct slugs", async () => {
    const { t, ids } = await freshApp(1);
    const r = await run(t, null, { owner_user_id: ids[0], orgs: [{ name: "Main" }, { name: "Main" }, { name: "x", slug: "main-2" }], invites: [{ email: "a@example.com", org_index: 0, role: "owner" }] });
    expect(r.e).toBeUndefined();
    expect((r.v as { orgs: { slug: string }[] }).orgs.map((o) => o.slug)).toEqual(["main", "main-3", "main-2"]);
    expect(r.hooks.find((h) => h.name === "org.send_mail")?.args.args?.url).toMatch(/^\/org\/accept\/[0-9a-f]{64}$/u);
    expect(t.db.query("select role from org__invites")).toEqual([{ role: "owner" }]);
  });

  test("on the real worker: the service route (anonymous) creates, queues one mail per invitation, emits the events; a second call is dead", async () => {
    const { t, ids } = await freshApp(1);
    const out = (await t.service("org").bootstrap!(REQ(ids[0] as string))) as { orgs: { id: string }[] };
    expect(out.orgs).toHaveLength(2);
    expect(counts(t)).toEqual({ orgs: 2, members: 2, invites: 2 });
    const sent = t.db.query<{ mail_to: string; url: string }>("select mail_to, url from orgmail__sent order by seq");
    expect(sent.map((s) => s.mail_to)).toEqual(["tech@example.com", "boss@example.com"]);
    expect(new URL(sent[0]?.url as string).pathname).toMatch(/^\/org\/accept\/[0-9a-f]{64}$/u);
    let events: unknown[] = [];
    for (let i = 0; i < 100 && events.length < 4; i++) {
      events = t.db.query("select name from orgmail__events order by seq");
      if (events.length < 4) await Bun.sleep(50);
    }
    expect(events).toEqual([{ name: "org.created" }, { name: "org.member_added" }, { name: "org.created" }, { name: "org.member_added" }]);
    const again = (await t
      .service("org")
      .bootstrap!(REQ(ids[0] as string))
      .catch((x: unknown) => x)) as ServiceError;
    expect(again).toBeInstanceOf(ServiceError);
    expect(again.code).toBe("RENOX_MODULE_SERVICE");
    expect(counts(t)).toEqual({ orgs: 2, members: 2, invites: 2 });
    expect(t.db.query("select count(*) as n from orgmail__sent")).toEqual([{ n: 2 }]);
  });

  test("a halting org.before_invite fails the call (ORG_INVITE_HALTED)", async () => {
    const { t, ids } = await freshApp(1);
    const r = await run(t, null, REQ(ids[0] as string), { halt: (e) => e === "boss@example.com" });
    expect(r.e?.code).toBe("ORG_INVITE_HALTED");
    expect(r.hooks.filter((h) => h.name === "org.send_mail")).toHaveLength(1);
  });

  test("the limits: RENOX_VALIDATION with details, nothing written", async () => {
    const { t, ids } = await freshApp(1);
    const o = ids[0] as string;
    const org = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Org ${i}` }));
    const inv = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.com`, org_index: 0, role: "member" }));
    const cases: [string, Input, string][] = [
      ["6 orgs", { owner_user_id: o, orgs: org(6), invites: [] }, "orgs"],
      ["no org", { owner_user_id: o, orgs: [], invites: [] }, "orgs"],
      ["orgs missing", { owner_user_id: o, invites: [] }, "orgs"],
      ["empty name", { owner_user_id: o, orgs: [{ name: "  " }] }, "orgs[0].name"],
      ["name too long", { owner_user_id: o, orgs: [{ name: "x".repeat(81) }] }, "orgs[0].name"],
      ["name without letters", { owner_user_id: o, orgs: [{ name: "!!!" }] }, "orgs[0].name"],
      ["bad slug", { owner_user_id: o, orgs: [{ name: "A", slug: "!!!" }] }, "orgs[0].slug"],
      ["same explicit slug", { owner_user_id: o, orgs: [{ name: "A", slug: "z" }, { name: "B", slug: "Z" }] }, "orgs[1].slug"],
      ["21 invites", { owner_user_id: o, orgs: org(1), invites: inv(21) }, "invites"],
      ["bad email", { owner_user_id: o, orgs: org(1), invites: [{ email: "nope", org_index: 0, role: "member" }] }, "invites[0].email"],
      ["staff role", { owner_user_id: o, orgs: org(1), invites: [{ email: "a@example.com", org_index: 0, role: "technician" }] }, "invites[0].role"],
      ["no role", { owner_user_id: o, orgs: org(1), invites: [{ email: "a@example.com", org_index: 0 }] }, "invites[0].role"],
      ["index out of range", { owner_user_id: o, orgs: org(1), invites: [{ email: "a@example.com", org_index: 1, role: "member" }] }, "invites[0].org_index"],
      ["negative index", { owner_user_id: o, orgs: org(1), invites: [{ email: "a@example.com", org_index: -1, role: "member" }] }, "invites[0].org_index"],
      ["fractional index", { owner_user_id: o, orgs: org(2), invites: [{ email: "a@example.com", org_index: 0.5, role: "member" }] }, "invites[0].org_index"],
      ["duplicate", { owner_user_id: o, orgs: org(2), invites: [{ email: "a@example.com", org_index: 0, role: "member" }, { email: "A@example.com", org_index: 0, role: "admin" }] }, "invites[1]"],
      ["unknown top-level field", { owner_user_id: o, orgs: org(1), invites: [], extra: 1 }, "extra"],
      ["unknown org field", { owner_user_id: o, orgs: [{ name: "A", locale: "ar" }] }, "orgs[0].locale"],
      ["unknown invite field", { owner_user_id: o, orgs: org(1), invites: [{ email: "a@example.com", org_index: 0, role: "member", note: "x" }] }, "invites[0].note"],
    ];
    for (const [label, input, field] of cases) {
      const r = await run(t, null, input);
      expect(r.e?.code, label).toBe("RENOX_VALIDATION");
      expect(r.e?.status, label).toBe(400);
      expect((r.e?.details as { field: string; reason: string }[]).map((d) => d.field), label).toContain(field);
      expect(counts(t), label).toEqual(NOTHING);
      expect(r.hooks, label).toEqual([]);
    }
    // The maximum is fine: 5 organisations, 20 invitations.
    const ok = await run(t, null, { owner_user_id: o, orgs: org(5), invites: inv(20) });
    expect(ok.e).toBeUndefined();
    expect(counts(t)).toEqual({ orgs: 5, members: 5, invites: 20 });
  });

  test("the guard: a session, a job or module, the platform: RENOX_FORBIDDEN (principal), nothing written", async () => {
    const { t, ids } = await freshApp(1);
    const o = ids[0] as string;
    for (const p of [{ kind: "user", id: o }, { kind: "user", id: "renox" }, { kind: "system", id: "email" }, { kind: "system", id: "app" }, { kind: "system", id: "renox" }]) {
      const r = await run(t, p, REQ(o));
      expect(r.e?.code, JSON.stringify(p)).toBe("RENOX_FORBIDDEN");
      expect(r.e?.status).toBe(403);
      expect(r.e?.details).toEqual({ action: "org.bootstrap", reason: "principal" });
      expect(r.e?.message).not.toContain(o);
      expect(r.hooks).toEqual([]);
      expect(r.events).toEqual([]);
      expect(counts(t)).toEqual(NOTHING);
    }
    // A signed-in session through the service route: refused, nothing written.
    const u = t.as("u1");
    expect((await u.action("/auth/login", "default", { email: "u1@example.com", password: "correct horse battery" })).status).toBe(303);
    const e = (await u
      .service("org")
      .bootstrap!(REQ(o))
      .catch((x: unknown) => x)) as ServiceError;
    expect(e).toBeInstanceOf(ServiceError);
    expect(e.code).toBe("RENOX_MODULE_SERVICE");
    expect(counts(t)).toEqual(NOTHING);
  });

  test("the guard: once an organisation or an invitation exists, bootstrap is dead (not_fresh)", async () => {
    const { t, ids } = await freshApp(1);
    const o = ids[0] as string;
    expect((await run(t, null, { owner_user_id: o, orgs: [{ name: "First" }] })).e).toBeUndefined();
    const before = counts(t);
    const r = await run(t, null, REQ(o));
    expect(r.e?.code).toBe("RENOX_FORBIDDEN");
    expect(r.e?.details).toEqual({ action: "org.bootstrap", reason: "not_fresh" });
    expect(counts(t)).toEqual(before);
    // An invitation alone is enough to refuse.
    const other = await freshApp(1);
    const b = other.t.db;
    expect(b).toBeDefined();
    const rw = new Database(other.t.dbFile);
    rw.query("insert into org__orgs (id, slug, name, created_by, created_at) values ('x', 'x', 'X', 'x', 1)").run();
    rw.query("insert into org__invites (id, org_id, token_hash, email, role, invited_by, expires_at, created_at) values ('i', 'x', 'h', 'a@example.com', 'member', 'x', 9, 1)").run();
    rw.query("delete from org__orgs").run();
    rw.close();
    expect(counts(other.t)).toEqual({ orgs: 0, members: 0, invites: 1 });
    const r2 = await run(other.t, null, REQ(other.ids[0] as string));
    expect(r2.e?.details).toEqual({ action: "org.bootstrap", reason: "not_fresh" });
  });

  test("the guard: the owner must be the app's only user (two users, an unknown id, no user, no id)", async () => {
    const two = await freshApp(2);
    for (const id of [two.ids[0], two.ids[1]]) {
      const r = await run(two.t, null, REQ(id as string));
      expect(r.e?.code).toBe("RENOX_FORBIDDEN");
      expect(r.e?.details).toEqual({ action: "org.bootstrap", reason: "owner" });
      expect(counts(two.t)).toEqual(NOTHING);
    }
    const one = await freshApp(1);
    for (const input of [REQ("nobody"), REQ(""), REQ(7 as unknown as string), { orgs: [{ name: "A" }] }, null]) {
      const r = await run(one.t, null, input);
      expect(r.e?.code).toBe("RENOX_FORBIDDEN");
      expect(r.e?.details).toEqual({ action: "org.bootstrap", reason: "owner" });
      expect(counts(one.t)).toEqual(NOTHING);
    }
    const none = await freshApp(0);
    expect((await run(none.t, null, REQ("anyone"))).e?.details).toEqual({ action: "org.bootstrap", reason: "owner" });
  });
});
