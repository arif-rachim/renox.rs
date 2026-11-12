// org.invite without a session (#751): an App MCP request with an agent token
// has a user principal and no cookie session, and `invite` then acts as that
// user under the same admin or owner check; no principal stays AUTH_REQUIRED.
// Runs on a ctx over the tenant file, as bootstrap.test.ts does.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

// core.ts imports `renox:modules`; no cookie session exists in these calls.
let cookieless = false;
mock.module("renox:modules", () => ({
  auth: {
    currentSession: async () => {
      // What auth answers an App MCP request: there is no cookie to read, so it fails.
      if (cookieless) throw new Error("auth.currentSession failed: Cannot read properties of undefined (reading 'get')");
      return null;
    },
  },
}));
const { invite } = await import("../lib/core.ts");

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;

type Principal = { kind: string; id: string } | null;

async function register(t: TestApp, n: number): Promise<string> {
  const u = t.as(`u${n}`);
  expect((await u.action("/auth/register", "default", { email: `u${n}@example.com`, password: "correct horse battery", display_name: `User ${n}` })).status).toBe(200);
  return t.db.query<{ id: string }>("select id from auth__users where email = ?", [`u${n}@example.com`])[0]?.id as string;
}

async function call(t: TestApp, principal: Principal, input: Record<string, unknown>) {
  const rw = new Database(t.dbFile);
  rw.exec("pragma busy_timeout = 5000");
  type P = SQLQueryBindings[];
  const mails: { to: string; args: { invited_by: string; url: string } }[] = [];
  const ctx = {
    principal,
    headers: new Headers(),
    config: {},
    db: {
      query: async (sql: string, params: P = []) => rw.query(sql).all(...params),
      queryOne: async (sql: string, params: P = []) => rw.query(sql).get(...params) ?? null,
      execute: async (sql: string, params: P = []) => ({ changes: rw.query(sql).run(...params).changes }),
    },
    events: { emit: async () => "evt" },
    hooks: {
      run: async (name: string, args: unknown) => {
        if (name === "org.send_mail") mails.push(structuredClone(args) as (typeof mails)[number]);
        return { halt: false };
      },
    },
  } as unknown as Parameters<typeof invite>[0];
  try {
    const result = await invite(ctx, input).then(
      (v) => ({ v }),
      (e: unknown) => ({ e: e as { code?: string } }),
    );
    return { ...result, mails };
  } finally {
    rw.close();
  }
}

describe.skipIf(!worker)("org.invite with no session (#751)", () => {
  test("a user principal invites as an admin of the org; a non-member is ORG_FORBIDDEN; no principal is AUTH_REQUIRED; a system principal is refused", async () => {
    const t = await app({ project: MODULE });
    const owner = await register(t, 1);
    const { orgs } = (await t.service("org").bootstrap!({ owner_user_id: owner, orgs: [{ name: "Dubai" }], invites: [] })) as { orgs: { id: string }[] };
    const org = orgs[0]?.id as string;
    const stranger = await register(t, 2);
    const input = { org, email: "New.Hire@Example.com", role: "member" };

    const ok = await call(t, { kind: "user", id: owner }, input);
    expect(ok.e).toBeUndefined();
    expect(ok.v).toMatchObject({ ok: true });
    expect(t.db.query("select email, role, invited_by from org__invites")).toEqual([{ email: "new.hire@example.com", role: "member", invited_by: owner }]);
    expect(ok.mails[0]?.args.invited_by).toBe("User 1");
    expect(ok.mails[0]?.args.url).toMatch(/^\/org\/accept\/[0-9a-f]{64}$/u);

    const outsider = await call(t, { kind: "user", id: stranger }, { ...input, email: "x@example.com" });
    expect(outsider.e?.code).toBe("ORG_FORBIDDEN");
    const anonymous = await call(t, null, { ...input, email: "y@example.com" });
    expect(anonymous.e?.code).toBe("AUTH_REQUIRED");
    const system = await call(t, { kind: "system", id: "app" }, { ...input, email: "z@example.com" });
    expect(system.e?.code).toBe("AUTH_REQUIRED");
    expect(t.db.query("select count(*) as n from org__invites")).toEqual([{ n: 1 }]);

    // A request that has no cookie at all: auth's lookup fails; a user principal still invites, anyone else gets that failure.
    cookieless = true;
    try {
      const viaToken = await call(t, { kind: "user", id: owner }, { ...input, email: "w@example.com" });
      expect(viaToken.e).toBeUndefined();
      expect(viaToken.v).toMatchObject({ ok: true });
      expect((await call(t, { kind: "user", id: stranger }, { ...input, email: "v@example.com" })).e?.code).toBe("ORG_FORBIDDEN");
      expect((await call(t, null, { ...input, email: "u@example.com" })).e).toBeInstanceOf(Error);
    } finally {
      cookieless = false;
    }
    expect(t.db.query("select count(*) as n from org__invites")).toEqual([{ n: 2 }]);
  });
});
