// Sign-up by phone (#773), the library level: an in-memory database with the
// module's migrations and a context that counts argon2 runs, sent codes and
// emitted events. Under a worker the outbox delivers an event and deletes
// the row before a test could read it, so the events are checked here.
// The page flows (cookies, status, headers) are in phone-signup.test.ts.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AuthCtx } from "../lib/core.ts";
import { CODE_ATTEMPTS, requestLoginCode, SIGNUPS_PER_IP_DAY, SIGNUPS_PER_IP_HOUR, verifyLoginCode } from "../lib/phone.ts";

const MIGRATIONS = join(import.meta.dir, "../migrations");
const KNOWN = "+971501234567";
const NEW = (n: number): string => `+97150000${String(n).padStart(4, "0")}`;

interface Emitted {
  name: string;
  payload: Record<string, unknown>;
}

function context(config: Record<string, unknown>, ip = "203.0.113.7") {
  const db = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  db.query("insert into auth__users (id, email, display_name, created_at, updated_at, password_hash, phone, phone_verified_at) values ('u_known', 'known@example.com', 'Known', 0, 0, 'x', ?, 1)").run(KNOWN);
  const log = { hashes: 0, verifies: 0, sent: [] as { to: string; code: string; purpose: string }[], emitted: [] as Emitted[] };
  const ctx: AuthCtx = {
    db: {
      query: async (sql, params = []) => db.query(sql).all(...(params as never[])) as never,
      queryOne: async (sql, params = []) => (db.query(sql).get(...(params as never[])) ?? null) as never,
      execute: async (sql, params = []) => {
        const r = db.query(sql).run(...(params as never[]));
        return { changes: r.changes, last_insert_rowid: Number(r.lastInsertRowid) } as never;
      },
    },
    headers: new Headers({ "x-renox-client-ip": ip }),
    config,
    password: {
      hash: async (p) => {
        log.hashes++;
        return `hash:${p}`;
      },
      verify: async (p, h) => {
        log.verifies++;
        return h === `hash:${p}`;
      },
    },
    events: {
      emit: async (name, payload) => {
        log.emitted.push({ name, payload });
        return `ev_${log.emitted.length}`;
      },
    },
    hooks: {
      run: async (name, args) => {
        if (name === "auth.send_otp") log.sent.push(args as { to: string; code: string; purpose: string });
        return { halt: false };
      },
    },
  };
  return { ctx, db, log };
}

const ON = { phone_login: true, phone_signup: true };
const users = (db: Database) => db.query("select * from auth__users where phone = ?");

describe("phone sign-up: requests", () => {
  test("a known and an unknown phone cost the same and answer the same; the unknown one has no user", async () => {
    const known = context(ON);
    const a = await requestLoginCode(known.ctx, KNOWN);
    const unknown = context(ON);
    const b = await requestLoginCode(unknown.ctx, NEW(1));
    expect(a).toEqual({ ok: true, phone: KNOWN, message: expect.any(String) });
    expect(b).toEqual({ ok: true, phone: NEW(1), message: (a as { message: string }).message });
    expect([known.log.hashes, known.log.sent.length]).toEqual([1, 1]);
    expect([unknown.log.hashes, unknown.log.sent.length]).toEqual([1, 1]);
    expect(unknown.log.sent[0]?.purpose).toBe("login");
    expect(users(unknown.db).all(NEW(1))).toEqual([]);
    expect(unknown.db.query("select count(*) as n from auth__phone_signups").get()).toEqual({ n: 1 });
    // The code is stored as a hash, in the pending row only.
    expect(unknown.db.query("select code_hash from auth__phone_signups").get()).toEqual({ code_hash: `hash:${unknown.log.sent[0]?.code}` });
  });

  test("phone_signup off, or phone_login off: an unknown phone gets nothing and costs one hash", async () => {
    for (const config of [{ phone_login: true }, { phone_login: true, phone_signup: false }, { phone_login: false, phone_signup: true }, {}]) {
      const c = context(config);
      const r = await requestLoginCode(c.ctx, NEW(2));
      expect(r.ok).toBe(true);
      expect(c.log.sent).toEqual([]);
      expect(c.log.hashes).toBe(1);
      expect(c.db.query("select count(*) as n from auth__phone_signups").get()).toEqual({ n: 0 });
    }
  });

  test("the per-IP account cap: past it a request answers the same, sends nothing, stores nothing", async () => {
    const c = context(ON);
    const sentBefore = c.log.sent.length;
    for (let i = 0; i < SIGNUPS_PER_IP_HOUR; i++) {
      await requestLoginCode(c.ctx, NEW(10 + i));
      const code = c.log.sent.at(-1)?.code;
      expect((await verifyLoginCode(c.ctx, NEW(10 + i), code, "/")).ok).toBe(true);
    }
    expect(c.log.sent.length - sentBefore).toBe(SIGNUPS_PER_IP_HOUR);
    const hashes = c.log.hashes;
    const r = await requestLoginCode(c.ctx, NEW(99));
    expect(r).toEqual({ ok: true, phone: NEW(99), message: expect.any(String) });
    expect(c.log.sent.length - sentBefore).toBe(SIGNUPS_PER_IP_HOUR);
    expect(c.log.hashes - hashes).toBe(1);
    expect(c.db.query("select count(*) as n from auth__phone_signups").get()).toEqual({ n: 0 });
    expect(c.db.query("select count(*) as n from auth__users where phone is not null").get()).toEqual({ n: SIGNUPS_PER_IP_HOUR + 1 });
    // A known phone is not affected by the account cap.
    await requestLoginCode(c.ctx, KNOWN);
    expect(c.log.sent.at(-1)?.to).toBe(KNOWN);
    // Another address is not affected either.
    const other = context(ON, "198.51.100.9");
    await requestLoginCode(other.ctx, NEW(99));
    expect(other.log.sent.length).toBe(1);
  });

  test("the daily cap: 20 accounts a day from one address, whatever the hour", async () => {
    const c = context(ON);
    // Spread over hours: age the hourly window after every account.
    for (let i = 0; i < SIGNUPS_PER_IP_DAY; i++) {
      c.db.query("update auth__attempts set window_start = window_start - 3700 where bucket like 'signup:h:%'").run();
      await requestLoginCode(c.ctx, NEW(200 + i));
      expect((await verifyLoginCode(c.ctx, NEW(200 + i), c.log.sent.at(-1)?.code, "/")).ok).toBe(true);
    }
    c.db.query("update auth__attempts set window_start = window_start - 3700 where bucket like 'signup:h:%'").run();
    const sent = c.log.sent.length;
    await requestLoginCode(c.ctx, NEW(299));
    expect(c.log.sent.length).toBe(sent);
  });
});

describe("phone sign-up: verifying", () => {
  test("a correct code creates one user: phone verified, no email, no password, no name; auth.user_registered source phone", async () => {
    const c = context(ON);
    await requestLoginCode(c.ctx, NEW(3));
    const r = await verifyLoginCode(c.ctx, NEW(3), c.log.sent[0]?.code, "/x");
    expect(r.ok).toBe(true);
    const row = c.db.query("select id, email, display_name, password_hash, phone, phone_verified_at, email_verified_at from auth__users where phone = ?").get(NEW(3)) as Record<string, unknown>;
    expect(row).toMatchObject({ display_name: "", password_hash: "!phone", phone: NEW(3), email_verified_at: null });
    expect(row.phone_verified_at).toEqual(expect.any(Number));
    expect(String(row.email)).toStartWith("!phone:");
    if (r.ok) expect(r.user).toMatchObject({ id: row.id, email: "", display_name: "" });
    expect(c.log.emitted.filter((e) => e.name === "auth.user_registered").map((e) => e.payload.source)).toEqual(["phone"]);
    expect(c.log.emitted.some((e) => e.name === "auth.login")).toBe(true);
    // The pending row is gone, and the public view shows no sentinel.
    expect(c.db.query("select count(*) as n from auth__phone_signups").get()).toEqual({ n: 0 });
    expect(c.db.query("select email from auth__public_users_v1 where id = ?").get(row.id as string)).toEqual({ email: "" });
    // A second sign-in creates no second user.
    await requestLoginCode(c.ctx, NEW(3));
    expect(c.db.query("select count(*) as n from auth__phone_signups").get()).toEqual({ n: 0 });
    const again = await verifyLoginCode(c.ctx, NEW(3), c.log.sent.at(-1)?.code, "/");
    expect(again.ok && again.user.id).toBe(row.id as string);
    expect(users(c.db).all(NEW(3)).length).toBe(1);
  });

  test("a wrong code five times locks the code; a wrong code never creates a user", async () => {
    const c = context(ON);
    await requestLoginCode(c.ctx, NEW(4));
    const right = c.log.sent[0]?.code as string;
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < CODE_ATTEMPTS; i++) expect((await verifyLoginCode(c.ctx, NEW(4), wrong, "/")).ok).toBe(false);
    expect((await verifyLoginCode(c.ctx, NEW(4), right, "/")).ok).toBe(false);
    expect(users(c.db).all(NEW(4))).toEqual([]);
  });

  test("a verify costs one argon2 check whether the phone is known, pending or unknown", async () => {
    const checks: number[] = [];
    for (const phone of [KNOWN, NEW(5), NEW(6)]) {
      const c = context(ON);
      if (phone !== NEW(6)) await requestLoginCode(c.ctx, phone);
      const code = c.log.sent[0]?.code ?? "123456";
      const before = c.log.hashes + c.log.verifies;
      await verifyLoginCode(c.ctx, phone, code, "/");
      checks.push(c.log.hashes + c.log.verifies - before);
    }
    expect(checks).toEqual([1, 1, 1]);
  });

  test("the cap is checked again at creation: nothing is created past it, the generic message, a login_failed locked", async () => {
    const c = context(ON);
    // Four codes issued while the cap was not reached yet.
    for (let i = 0; i < SIGNUPS_PER_IP_HOUR + 1; i++) await requestLoginCode(c.ctx, NEW(30 + i));
    const codes = c.log.sent.map((s) => s.code);
    let last: Awaited<ReturnType<typeof verifyLoginCode>> | undefined;
    for (let i = 0; i < SIGNUPS_PER_IP_HOUR + 1; i++) last = await verifyLoginCode(c.ctx, NEW(30 + i), codes[i], "/");
    expect(last?.ok).toBe(false);
    expect(last && !last.ok && last.error).toContain("incorrect or has expired");
    expect(users(c.db).all(NEW(30 + SIGNUPS_PER_IP_HOUR))).toEqual([]);
    expect(c.db.query("select count(*) as n from auth__users where phone is not null").get()).toEqual({ n: SIGNUPS_PER_IP_HOUR + 1 }); // + the known user
    const failed = c.log.emitted.filter((e) => e.name === "auth.login_failed");
    expect(failed.map((e) => e.payload.reason)).toEqual(["locked"]);
    expect(JSON.stringify(failed)).not.toContain(NEW(30));
  });
});
