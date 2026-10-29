// The audit module on the real worker (#288): append-only rows (module
// code, app code, and the file itself are refused an UPDATE or DELETE:
// docs/24-threat-model.md "Audit library append-only; tenant cannot edit
// or delete audit rows"), redaction, the listeners, the platform's
// decisions in the same trail, pagination, export, and retention.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, ServiceError, type TestApp } from "../../../sdk/src/test.ts";
import { isSecretKey, redact } from "../lib/redact.ts";

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

const idOf = (email: string): string => t.db.query<{ id: string }>("select id from auth__users where email = ?", [email])[0]?.id as string;

/** Rows of audit__events once the listeners have run (they run after the commit). */
async function rows(where: string, params: string[], n: number) {
  let r: { action: string; actor_kind: string; actor_id: string; details: string; source: string }[] = [];
  for (let i = 0; i < 100 && r.length < n; i++) {
    r = t.db.query(`select action, actor_kind, actor_id, details, source from audit__events where ${where} order by at, id`, params);
    if (r.length < n) await Bun.sleep(50);
  }
  return r;
}

describe("redaction", () => {
  test("secret-looking keys lose their value at any depth; values and innocent keys stay", () => {
    expect(["password", "apiKey", "API_KEY", "access_token", "client_secret", "Authorization", "cookie", "otp", "cardNumber", "tokenHash"].every(isSecretKey)).toBe(true);
    expect(["footprint", "title", "org_id", "role", "keyboard", "passage_count"].some(isSecretKey)).toBe(false);
    expect(redact({ a: { b: [{ password: "x", ok: 1 }] }, note: "the password is x" })).toEqual({ a: { b: [{ password: "[redacted]", ok: 1 }] }, note: "the password is x" });
  });
});

describe.skipIf(!worker)("audit", () => {
  let auditor: TestApp;
  let auditorId = "";

  test("listeners: auth.login and org events become rows with the actor", async () => {
    auditor = await user("audrey");
    auditorId = idOf("audrey@example.com");
    const login = await rows("action = 'auth.login' and actor_id = ?", [auditorId], 1);
    expect(login[0]).toMatchObject({ actor_kind: "user", source: "auth.login" });
    expect((await auditor.action("/org", "create", { name: "Audit Org", slug: "" })).status).toBe(303);
    const org = await rows("action like 'org.%' and actor_id = ?", [auditorId], 2);
    expect(org.map((r) => r.action).sort()).toEqual(["org.created", "org.member_added"]);
  });

  test("record through another module: redacted details, the agent actor and its client", async () => {
    const r = (await t.service("tamper").note(auditorId)) as { id: string };
    const row = t.db.query<{ actor_kind: string; client: string; details: string; resource_type: string }>("select actor_kind, client, details, resource_type from audit__events where id = ?", [r.id])[0];
    expect(row).toMatchObject({ actor_kind: "agent", client: "Test Agent", resource_type: "tamper:Note" });
    expect(JSON.parse(row?.details as string)).toEqual({ title: "hello", password: "[redacted]", nested: { apiKey: "[redacted]", accessToken: "[redacted]", ok: 1 }, list: [{ client_secret: "[redacted]" }], footprint: "kept" });
    expect(row?.details).not.toContain("hunter2");
    expect(row?.details).not.toContain("sk_live_x");
    // A malformed event is refused.
    await expect(t.service("audit").record({ action: "nope", actor: { kind: "user", id: "u" } })).rejects.toBeInstanceOf(ServiceError);
    await expect(t.service("audit").record({ action: "x.y", actor: { kind: "robot", id: "u" } })).rejects.toBeInstanceOf(ServiceError);
  });

  test("append-only: module code and app code cannot update or delete; neither can a tool opening the file", async () => {
    const before = t.db.query<{ n: number }>("select count(*) as n from audit__events")[0]?.n as number;
    expect(before).toBeGreaterThan(0);
    // Another module: the authorizer (not its table).
    const m = (await t.service("tamper").attack()) as Record<string, string>;
    expect(m).toEqual({ update: "RENOX_DB_AUTH", delete: "RENOX_DB_AUTH", insert: "RENOX_DB_AUTH", platform_delete: "RENOX_DB_AUTH" });
    // The app: the triggers, and the authorizer for the platform table.
    const a = (await auditor.request("POST", "/api/tamper")).json<Record<string, string>>();
    for (const k of ["update", "delete", "drop_trigger", "platform_update", "platform_delete"]) expect(a[k]).not.toBe("allowed");
    // The file itself (no authorizer at all): the triggers refuse.
    const rw = new Database(t.dbFile);
    try {
      expect(() => rw.run("update audit__events set action = 'x.y'")).toThrow("append-only");
      expect(() => rw.run("delete from audit__events")).toThrow("append-only");
    } finally {
      rw.close();
    }
    expect(t.db.query<{ n: number }>("select count(*) as n from audit__events")[0]?.n).toBe(before);
    expect(t.db.query("select 1 from audit__events where id = 'forged'")).toEqual([]);
  });

  test("query: refused without audit.read (and the refusal is in the platform table); an auditor sees both trails, newest first, paged", async () => {
    const nobody = await user("nobody");
    const denied = await nobody.service("audit").query({}).then(
      () => null,
      (e: unknown) => e as ServiceError,
    );
    expect(denied).toBeInstanceOf(ServiceError);
    expect((await auditor.request("POST", "/api/grant")).status).toBe(200);
    // The role change is recorded by the listener.
    expect((await rows("action = 'authz.roles_changed'", [], 1))[0]).toMatchObject({ actor_kind: "system", actor_id: "system:authz" });
    const first = (await auditor.service("audit").query({ limit: 3 })) as { events: { kind: string; action: string; result: string; at: number; actor_id: string }[]; next: string | null };
    expect(first.events).toHaveLength(3);
    expect(first.next).not.toBeNull();
    // This query itself is the newest platform row: a sensitive action, allowed.
    expect(first.events[0]).toMatchObject({ kind: "authz", action: "audit.read", result: "allow", actor_id: auditorId });
    // The earlier refusal is there too.
    const all: { kind: string; action: string; result: string; at: number; actor_id: string }[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const p = (await auditor.service("audit").query({ limit: 4, cursor })) as { events: typeof all; next: string | null };
      all.push(...p.events);
      if (p.next === null) break;
      cursor = p.next;
    }
    expect(all.some((e) => e.kind === "authz" && e.action === "audit.read" && e.result === "deny" && e.actor_id === idOf("nobody@example.com"))).toBe(true);
    expect(all.some((e) => e.kind === "module" && e.action === "tamper.note")).toBe(true);
    // Newest first, no duplicate across pages.
    for (let i = 1; i < all.length; i++) expect((all[i - 1]?.at as number) >= (all[i]?.at as number)).toBe(true);
    expect(new Set(all.map((e) => `${e.kind}:${JSON.stringify(e)}`)).size).toBe(all.length);
    // Filters.
    const org = (await auditor.service("audit").query({ action: "org.", platform: false })) as { events: { action: string }[] };
    expect(org.events.map((e) => e.action).sort()).toEqual(["org.created", "org.member_added"]);
    // A dependant reads the platform view directly.
    expect(((await t.service("tamper").platformRows()) as { action: string }[]).some((r) => r.action === "audit.read")).toBe(true);
  });

  test("export: one hook call per page; prune keeps everything younger than retain_days and the 30-day floor", async () => {
    const r = (await auditor.service("audit").exportEvents({ platform: false }, "erasure")) as { events: number; pages: number };
    expect(r.pages).toBe(1);
    expect(t.db.query("select page, last, events, purpose from tamper__exports")).toEqual([{ page: 0, last: 1, events: r.events, purpose: "erasure" }]);
    const n = t.db.query<{ n: number }>("select count(*) as n from audit__events")[0]?.n;
    expect(await t.service("audit").prune()).toEqual({ deleted: 0 });
    expect(t.db.query<{ n: number }>("select count(*) as n from audit__events")[0]?.n).toBe(n);
  });
});
