// The auth module on the real worker (`renox test` in modules/auth, #238):
// register, login, logout, session rotation, idle and absolute expiry, the
// failure bucket, requireUser's redirect with a safe `next`, the public
// view, and the cookie (#239; docs/24-threat-model.md F4 rows "Login brute
// force, credential stuffing, enumeration", "Session fixation", "Open
// redirect via next/return_to"; docs/04-isolation-security.md, cookies).
// The negative suite is tests/negative/ (#100).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The SDK helper by path: a module tree has no node_modules (its hash covers every file).
import { app, policyCases, ServiceError, type TestApp } from "../../../sdk/src/test.ts";
import { redirect, safeRedirectTarget } from "../../../sdk/src/redirect.ts";
import { loginUrl, redirectWith, safePath } from "../lib/core.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;

const cookieOf = (r: { headers: Headers }, name = "__Host-renox_auth"): string | undefined => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

/** Register (a confirmation link is mailed; no session), then sign in with the password. */
async function signUp(t: TestApp, email: string, password = "correct horse battery"): Promise<void> {
  const r = await t.action("/auth/register", "default", { email, password, display_name: email.split("@")[0] as string, next: "/" });
  expect(r.status).toBe(200);
  expect((await t.action("/auth/login", "default", { email, password })).status).toBe(303);
}

const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("auth", () => {
  test("register: user with an argon2id hash at the platform's parameters, the confirmation mail, the event; then sign in", async () => {
    const r = await t.as("ann").action("/auth/register", "default", { email: "Ann@Example.com", password: "correct horse battery", display_name: "Ann", next: "/private" });
    expect(r.status).toBe(200);
    expect(cookieOf(r)).toBeUndefined();
    expect(r.html).toContain("Check your inbox");
    expect(t.db.query<{ template: string }>("select template from mailer__sent where mail_to = 'ann@example.com'")).toEqual([{ template: "verify_email" }]);
    const login = await t.as("ann").action("/auth/login", "default", { email: "ann@example.com", password: "correct horse battery", next: "/private" });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/private");
    const users = t.db.query<{ email: string; password_hash: string }>("select email, password_hash from auth__users");
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe("ann@example.com");
    expect(users[0]?.password_hash.startsWith("$argon2id$v=19$m=65536,t=3,p=1$")).toBe(true);
    // auth.user_registered is durable: the reader fixture's handler gets it after the commit.
    const id = t.db.query<{ id: string }>("select id from auth__users where email = 'ann@example.com'")[0]?.id;
    let seen: { user_id: string }[] = [];
    for (let i = 0; i < 100 && seen.length === 0; i++) {
      await Bun.sleep(50);
      seen = t.db.query<{ user_id: string }>("select user_id from reader__registered");
    }
    expect(seen).toEqual([{ user_id: id as string }]);
    // Signed in: the private page greets her.
    const page = await t.as("ann").page("/private");
    expect(page.status).toBe(200);
    expect(page.html).toContain(">Hello Ann</h1>");
  });

  test("the session cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/; only its hash is stored", async () => {
    await t.as("cookie").action("/auth/register", "default", { email: "cookie@example.com", password: "correct horse battery", next: "/" });
    const r = await t.as("cookie").action("/auth/login", "default", { email: "cookie@example.com", password: "correct horse battery" });
    const c = cookieOf(r) as string;
    expect(c).toMatch(/^__Host-renox_auth=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/u);
    const token = c.split(";")[0]?.split("=")[1] as string;
    const stored = t.db.query<{ token_hash: string }>("select token_hash from auth__sessions");
    expect(stored.some((s) => s.token_hash === token)).toBe(false);
    expect(stored.every((s) => /^[0-9a-f]{64}$/u.test(s.token_hash))).toBe(true);
  });

  test("login and logout through the pages; logout revokes server side", async () => {
    await signUp(t.as("setup-bob"), "bob@example.com");
    const bob = t.as("bob");
    const r = await bob.action("/auth/login", "default", { email: "bob@example.com", password: "correct horse battery", next: "/private" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/private");
    expect((await bob.page("/private")).status).toBe(200);
    const token = (cookieOf(r) as string).split(";")[0] as string;
    const out = await bob.action("/auth/account", "logout", {});
    expect(out.status).toBe(303);
    expect(cookieOf(out)).toContain("Max-Age=0");
    // The old cookie, replayed: refused, the session is revoked in the table.
    const replay = await t.request("GET", "/private", { headers: { cookie: token } });
    expect(replay.status).toBe(303);
    const hash = new Bun.CryptoHasher("sha256").update(token.split("=")[1] as string).digest("hex");
    expect(t.db.query<{ revoked: number }>("select revoked_at is not null as revoked from auth__sessions where token_hash = ?", [hash])).toEqual([{ revoked: 1 }]);
  });

  test("session rotation: a new session at every sign-in; a password change signs out the others", async () => {
    await signUp(t.as("setup-cara"), "cara@example.com");
    const cara = t.as("cara");
    const first = await cara.action("/auth/login", "default", { email: "cara@example.com", password: "correct horse battery" });
    const second = await cara.action("/auth/login", "default", { email: "cara@example.com", password: "correct horse battery" });
    const a = (cookieOf(first) as string).split(";")[0] as string;
    const b = (cookieOf(second) as string).split(";")[0] as string;
    expect(a).not.toBe(b);
    // The first token is dead: signing in again revoked it (fixation).
    expect((await t.request("GET", "/private", { headers: { cookie: a } })).status).toBe(303);
    expect((await t.request("GET", "/private", { headers: { cookie: b } })).status).toBe(200);
    // Another browser of cara's; then a password change in this one.
    const other = t.as("cara-phone");
    await other.action("/auth/login", "default", { email: "cara@example.com", password: "correct horse battery" });
    expect((await other.page("/private")).status).toBe(200);
    const changed = await cara.action("/auth/account", "password", { current: "correct horse battery", password: "a much better passphrase" });
    expect(changed.status).toBe(303);
    expect(cookieOf(changed)).toMatch(/^__Host-renox_auth=[0-9a-f]{64};/u);
    expect((await other.page("/private")).status).toBe(303);
    expect((await cara.page("/private")).status).toBe(200);
  });

  test("idle and absolute expiry", async () => {
    await signUp(t.as("dan"), "dan@example.com");
    const dan = t.as("dan");
    expect((await dan.page("/private")).status).toBe(200);
    const rw = new Database(t.dbFile);
    rw.exec("pragma busy_timeout = 5000"); // the worker may hold the writer a moment (the outbox)
    try {
      const id = (u: string) => `(select id from auth__users where email = '${u}')`;
      // Idle: last seen 25 hours ago (session_idle_hours = 24).
      rw.exec(`update auth__sessions set last_seen_at = unixepoch() - 25 * 3600 where user_id = ${id("dan@example.com")}`);
      expect((await dan.page("/private")).status).toBe(303);
      await signUp(t.as("eve"), "eve@example.com");
      const eve = t.as("eve");
      // Absolute: used a minute ago, but past its absolute expiry.
      rw.exec(`update auth__sessions set last_seen_at = unixepoch() - 60, absolute_expires_at = unixepoch() - 1 where user_id = ${id("eve@example.com")}`);
      expect((await eve.page("/private")).status).toBe(303);
    } finally {
      rw.close();
    }
  });

  test("ten failures lock the account: the right password then gets the same generic message", async () => {
    await signUp(t.as("setup-finn"), "finn@example.com");
    const finn = t.as("finn");
    const wrong = await finn.action("/auth/login", "default", { email: "finn@example.com", password: "not the password" });
    const unknown = await finn.action("/auth/login", "default", { email: "nobody@example.com", password: "not the password" });
    const message = (h: string) => /<p class="error" id="error"[^>]*>([^<]*)<\/p>/u.exec(h)?.[1];
    // Wrong password and unknown email answer alike (enumeration).
    expect(message(wrong.html)).toBe(message(unknown.html));
    for (let i = 0; i < 9; i++) await finn.action("/auth/login", "default", { email: "finn@example.com", password: "still not it" });
    const locked = await finn.action("/auth/login", "default", { email: "finn@example.com", password: "correct horse battery" });
    expect(locked.status).toBe(200);
    expect(message(locked.html)).toBe(message(wrong.html));
    expect(cookieOf(locked)).toBeUndefined();
  });

  test("requireUser: a page redirects to the login with a safe next; an API answers 401", async () => {
    const anon = t.as("anon");
    const r = await anon.page("/private?tab=1");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/auth/login?next=%2Fprivate%3Ftab%3D1");
    const api = await anon.request("GET", "/api/me");
    expect(api.status).toBe(401);
    // An off-site `next` is dropped: the redirect goes to the app's root.
    await signUp(t.as("setup-gail"), "gail@example.com");
    for (const next of ["//evil.example/x", "https://evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
      const login = await t.as(`gail-${next}`).action("/auth/login", "default", { email: "gail@example.com", password: "correct horse battery", next });
      expect(login.status).toBe(303);
      expect(login.headers.get("location")).toBe("/");
    }
  });

  test("the public view has the four columns; another module reads it and is refused on auth__users", async () => {
    const cols = t.db.query<{ name: string }>("select name from pragma_table_info('auth__public_users_v1')").map((c) => c.name);
    expect(cols).toEqual(["id", "email", "display_name", "created_at"]);
    const names = (await t.service("reader").names()) as { display_name: string }[];
    expect(names.map((n) => n.display_name)).toContain("Ann");
    const refused = await t.service("reader").hashes().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe("RENOX_MODULE_SERVICE");
    expect(((refused as ServiceError).details as { cause_code: string }).cause_code).toBe("RENOX_DB_AUTH");
  });

  test("services: login, currentUser, logout from app code", async () => {
    const r = (await t.service("auth").login({ email: "ann@example.com", password: "wrong" })) as { error?: string };
    expect(r.error).toContain("incorrect");
    const ok = (await t.service("auth").login({ email: "ann@example.com", password: "correct horse battery" })) as { user: { email: string }; cookie: string };
    expect(ok.user.email).toBe("ann@example.com");
    expect(ok.cookie).toMatch(/^__Host-renox_auth=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/u);
    expect(await t.service("auth").loginUrl("//evil.example")).toBe("/auth/login");
    expect(await t.service("auth").loginUrl("/orders/7")).toBe("/auth/login?next=%2Forders%2F7");
  });

  policyCases(join(MODULE, "policies", "tests"));
});

// docs/24-threat-model.md A, "Open redirect via `next`/`return_to`" (#275
// item 1): every redirect of auth (redirectWith, loginUrl) answers what
// redirect.safe() of "renox" answers, on the fixture list of #111
// (sdk/tests/redirect.test.ts). No worker needed.
describe("auth redirects go through the redirect.safe() rules", () => {
  // sdk/tests/redirect.test.ts REJECTED, plus the targets #111's check test drives.
  const REJECTED = [
    "//evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://evil.example/",
    "http://accounts.example.com/",
    "https://accounts.example.com.evil.example/",
    "https://accounts.example.com@evil.example/",
    "https://user:pw@accounts.example.com/",
    "dashboard",
    "../admin",
    "",
    `/${"a".repeat(2048)}`,
  ];
  const ACCEPTED = ["/", "/account/settings?tab=billing#top", "/orders/7"];

  test("safePath is safeRedirectTarget without allowed origins", () => {
    for (const target of [...REJECTED, ...ACCEPTED]) expect([target, safePath(target)]).toEqual([target, safeRedirectTarget(target)]);
  });

  test("redirectWith: the same Location as redirect.safe(target, { fallback }), cookies kept", () => {
    for (const target of [...REJECTED, ...ACCEPTED]) {
      const ours = redirectWith(target, ["a=1"], "/home");
      const sdk = redirect.safe(target, { fallback: "/home" });
      expect([target, ours.status, ours.headers.get("location")]).toEqual([target, sdk.status, sdk.headers.get("location")]);
      expect(ours.headers.getSetCookie()).toEqual(["a=1"]);
    }
    // An unsafe fallback becomes "/", as in redirect.safe.
    expect(redirectWith("//evil.example", [], "https://evil.example").headers.get("location")).toBe("/");
    expect(redirectWith(null, []).headers.get("location")).toBe("/");
  });

  test("loginUrl keeps next only when redirect.safe would", () => {
    const ctx = { config: { login_path: "/auth/login" } };
    for (const target of REJECTED) expect([target, loginUrl(ctx, target)]).toEqual([target, "/auth/login"]);
    for (const target of ACCEPTED) expect(loginUrl(ctx, target)).toBe(`/auth/login?next=${encodeURIComponent(target)}`);
    expect(loginUrl({ config: { login_path: "//evil.example/login" } }, "/x")).toBe("/auth/login?next=%2Fx");
  });
});
