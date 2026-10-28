// Accounts, sessions, roles, and token hygiene (#113; docs/24-threat-model.md
// E: "Account takeover of a tenant developer", "Leaked CLI or CI token",
// "Teammate with too much power").

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE, SESSION_IDLE_MS } from "../src/auth/sessions.ts";
import { DAY_MS, sha256hex } from "../src/auth/tokens.ts";
import { named, upload } from "./artifacts.ts";
import { addMember, assertScoped, harness, login, mailToken, PASSWORD, registeredNode, setCookie, signup, type Harness, type Session } from "./helpers.ts";

afterEach(assertScoped);

const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const audit = (h: Harness, action: string) =>
  h.db.query<{ tenant_id: string | null; actor: string; target: Record<string, string>; status: number; ip: string | null }>(
    "select tenant_id, actor, target, status, ip from audit where action = $1 order by id",
    [action],
  );

/** A token created by `session` with `scopes`. */
async function tokenOf(h: Harness, session: Session, scopes: string[], days = 30): Promise<{ id: string; token: string }> {
  const res = await h.request("POST", "/v1/tokens", { session, json: { name: "t", scopes, expires_in_days: days } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

describe("sign-up, verification, login", () => {
  test("sign-up answers 202 whether or not the address exists; the second attempt mails the owner instead", async () => {
    const h = await harness();
    const first = await h.request("POST", "/v1/account/signup", { json: { email: "Dev@Example.test", password: PASSWORD, tenant_id: "t-dev" } });
    const again = await h.request("POST", "/v1/account/signup", { json: { email: "dev@example.test", password: "another password" } });
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(await first.json()).toEqual(await again.json());
    expect(h.mailer.sent.map((m) => [m.to, m.kind])).toEqual([
      ["dev@example.test", "verify_email"],
      ["dev@example.test", "signup_exists"],
    ]);
    const [user] = await h.db.query<{ password_hash: string }>("select password_hash from users");
    expect(user?.password_hash).toStartWith("$argon2id$");
    expect((await h.db.query("select role from memberships where tenant_id = 't-dev'"))[0]).toEqual({ role: "owner" });
    // A taken tenant id is a conflict, naming no owner.
    const taken = await h.request("POST", "/v1/account/signup", { json: { email: "x@example.test", password: PASSWORD, tenant_id: "t-dev" } });
    expect(taken.status).toBe(409);
  });

  test("the verification link works once", async () => {
    const h = await harness();
    await h.request("POST", "/v1/account/signup", { json: { email: "v@example.test", password: PASSWORD } });
    const token = mailToken(h, "v@example.test", "verify_email");
    expect((await h.request("POST", "/v1/account/verify", { json: { token } })).status).toBe(200);
    expect((await h.request("POST", "/v1/account/verify", { json: { token } })).status).toBe(404);
    expect((await h.request("POST", "/v1/account/verify", { json: { token: "nonsense" } })).status).toBe(404);
  });

  test("unknown address and wrong password: the same 401; the session cookie is __Host-, HttpOnly, Secure, SameSite=Strict", async () => {
    const h = await harness();
    await signup(h, "u@example.test", "t-u");
    const unknown = await h.request("POST", "/v1/account/login", { json: { email: "nobody@example.test", password: PASSWORD } });
    const wrong = await h.request("POST", "/v1/account/login", { json: { email: "u@example.test", password: "wrong password!" } });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const strip = (b: Record<string, Record<string, unknown>>) => ({ ...b.error, request_id: "" });
    expect(strip((await unknown.json()) as never)).toEqual(strip((await wrong.json()) as never));
    expect(unknown.headers.getSetCookie()).toEqual([]);

    const ok = await h.request("POST", "/v1/account/login", { json: { email: "u@example.test", password: PASSWORD } });
    expect(ok.status).toBe(200);
    const line = ok.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`)) as string;
    expect(line).toMatch(/^__Host-renox_session=renox_ses_[a-z2-7]{32}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000$/u);
    const body = await json(ok);
    expect(body).toMatchObject({ email: "u@example.test", email_verified: true, tenant_id: "t-u", role: "owner" });
    // The cookie value is stored only as its hash.
    const value = setCookie(ok, SESSION_COOKIE) as string;
    const stored = JSON.stringify(await h.db.query("select * from sessions"));
    expect(stored).not.toContain(value);
    expect(stored).toContain(sha256hex(value));
    // Login is audited, success and failure, without the address or password.
    const rows = await audit(h, "login");
    expect(rows.map((r) => r.status)).toEqual([200, 401, 401, 200]);
    expect(JSON.stringify(rows)).not.toContain("u@example.test");
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(rows.at(-1)?.ip).toBe("192.0.2.10");
  });

  test("login buckets: per address and per email, 429 with Retry-After", async () => {
    const h = await harness();
    await signup(h, "b@example.test", "t-b");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await h.request("POST", "/v1/account/login", { json: { email: "b@example.test", password: "wrong password!" }, ip: `198.51.100.${i}` })).status);
    }
    // signup's login took one of the 5 per email; wrong passwords take the rest.
    expect(statuses).toEqual([401, 401, 401, 401, 429, 429]);
    const limited = await h.request("POST", "/v1/account/login", { json: { email: "b@example.test", password: PASSWORD }, ip: "203.0.113.1" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    h.clock.now += 5 * 60_000;
    expect((await h.request("POST", "/v1/account/login", { json: { email: "b@example.test", password: PASSWORD }, ip: "203.0.113.1" })).status).toBe(200);
    // Per address: one address cannot spray many accounts.
    const spray: number[] = [];
    for (let i = 0; i < 11; i++) spray.push((await h.request("POST", "/v1/account/login", { json: { email: `n${i}@example.test`, password: "wrong password!" }, ip: "203.0.113.9" })).status);
    expect(spray.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(spray[10]).toBe(429);
  });

  test("a new browser gets the new-device email; the same browser does not", async () => {
    const h = await harness();
    await signup(h, "d@example.test", "t-d");
    expect(h.mailer.last("d@example.test", "new_device")).toBeUndefined(); // the first browser ever
    const res = await h.request("POST", "/v1/account/login", { json: { email: "d@example.test", password: PASSWORD } });
    expect(h.mailer.last("d@example.test", "new_device")?.text).toContain("192.0.2.10");
    const device = setCookie(res, "__Host-renox_device") as string;
    const count = h.mailer.sent.length;
    await h.request("POST", "/v1/account/login", { json: { email: "d@example.test", password: PASSWORD }, headers: { cookie: `__Host-renox_device=${device}` } });
    expect(h.mailer.sent.length).toBe(count);
  });

  test("email verification before the first deploy", async () => {
    const h = await harness();
    await registeredNode(h, "node-1");
    const session = await signup(h, "nv@example.test", "t-nv", false);
    const { token } = await tokenOf(h, session, ["*"]);
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "nv-app" } })).status).toBe(201);
    const refused = await upload(h, token, "nv-app", named("nv-app"));
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ error: { code: "RENOX_TOKEN_SCOPE", details: [{ field: "email" }] } });
    await h.request("POST", "/v1/account/verify", { json: { token: mailToken(h, "nv@example.test", "verify_email") } });
    expect((await upload(h, token, "nv-app", named("nv-app"))).status).toBe(201);
  });
});

describe("password reset", () => {
  test("single-use link; the old password stops working; every session ends; unknown addresses get the same 202", async () => {
    const h = await harness();
    const s1 = await signup(h, "r@example.test", "t-r");
    const unknown = await h.request("POST", "/v1/account/password-reset", { json: { email: "nobody@example.test" } });
    const known = await h.request("POST", "/v1/account/password-reset", { json: { email: "r@example.test" } });
    expect([unknown.status, known.status]).toEqual([202, 202]);
    expect(h.mailer.sent.filter((m) => m.kind === "password_reset").map((m) => m.to)).toEqual(["r@example.test"]);
    const token = mailToken(h, "r@example.test", "password_reset");
    expect((await h.request("POST", "/v1/account/password-reset/confirm", { json: { token, password: "short" } })).status).toBe(400);
    expect((await h.request("POST", "/v1/account/password-reset/confirm", { json: { token, password: "a brand new password" } })).status).toBe(204);
    expect((await h.request("POST", "/v1/account/password-reset/confirm", { json: { token, password: "a third password!" } })).status).toBe(404);
    expect((await h.request("GET", "/v1/account", { session: s1 })).status).toBe(401);
    expect((await h.request("POST", "/v1/account/login", { json: { email: "r@example.test", password: PASSWORD } })).status).toBe(401);
    expect((await h.request("POST", "/v1/account/login", { json: { email: "r@example.test", password: "a brand new password" } })).status).toBe(200);
    expect(h.mailer.last("r@example.test", "password_changed")).toBeDefined();
  });

  test("a reset link expires after an hour", async () => {
    const h = await harness();
    await signup(h, "e@example.test", "t-e");
    await h.request("POST", "/v1/account/password-reset", { json: { email: "e@example.test" } });
    h.clock.now += 3_600_000;
    const token = mailToken(h, "e@example.test", "password_reset");
    expect((await h.request("POST", "/v1/account/password-reset/confirm", { json: { token, password: "a brand new password" } })).status).toBe(404);
  });
});

describe("sessions", () => {
  test("list of active sessions; sign out one; sign out everywhere", async () => {
    const h = await harness();
    const s1 = await signup(h, "s@example.test", "t-s");
    const s2 = await login(h, "s@example.test", PASSWORD, {}, "198.51.100.7");
    const list = (await json(await h.request("GET", "/v1/account/sessions", { session: s1 }))).sessions as { id: string; current: boolean; ip: string }[];
    expect(list.length).toBe(2);
    expect(list.filter((s) => s.current).length).toBe(1);
    expect(list.map((s) => s.ip).sort()).toEqual(["192.0.2.10", "198.51.100.7"]);
    const other = list.find((s) => !s.current)?.id as string;
    expect((await h.request("DELETE", `/v1/account/sessions/${other}`, { session: s1 })).status).toBe(204);
    expect((await h.request("GET", "/v1/account", { session: s2 })).status).toBe(401);
    expect((await h.request("GET", "/v1/account", { session: s1 })).status).toBe(200);

    const s3 = await login(h, "s@example.test");
    const out = await h.request("POST", "/v1/account/sessions/revoke-all", { session: s3 });
    expect(await json(out)).toEqual({ revoked: 2 });
    expect(out.headers.getSetCookie()[0]).toContain("Max-Age=0");
    for (const s of [s1, s3]) expect((await h.request("GET", "/v1/account", { session: s })).status).toBe(401);
    expect((await h.request("GET", "/v1/apps", { session: s1 })).status).toBe(401);
  });

  test("idle expiry after 24 hours without a request; activity keeps the session alive", async () => {
    const h = await harness();
    const s = await signup(h, "i@example.test", "t-i");
    h.clock.now += SESSION_IDLE_MS - 60_000;
    expect((await h.request("GET", "/v1/apps", { session: s })).status).toBe(200);
    h.clock.now += SESSION_IDLE_MS - 60_000;
    expect((await h.request("GET", "/v1/apps", { session: s })).status).toBe(200);
    h.clock.now += SESSION_IDLE_MS;
    expect((await h.request("GET", "/v1/apps", { session: s })).status).toBe(401);
  });

  test("absolute expiry after 30 days, however active", async () => {
    const h = await harness();
    const s = await signup(h, "a@example.test", "t-a");
    for (let t = 0; t < SESSION_ABSOLUTE_MS - DAY_MS; t += DAY_MS / 2) {
      h.clock.now += DAY_MS / 2;
      expect((await h.request("GET", "/v1/apps", { session: s })).status).toBe(200);
    }
    h.clock.now += DAY_MS;
    expect((await h.request("GET", "/v1/apps", { session: s })).status).toBe(401);
  });

  test("a mutating request with the cookie needs the CSRF header", async () => {
    const h = await harness();
    const s = await signup(h, "c@example.test", "t-c");
    const without = await h.request("POST", "/v1/apps", { json: { name: "c-app" }, headers: { cookie: `${SESSION_COOKIE}=${s.cookie}` } });
    expect(without.status).toBe(403);
    const wrong = await h.request("POST", "/v1/apps", { session: { ...s, csrf: "0".repeat(64) }, json: { name: "c-app" } });
    expect(wrong.status).toBe(403);
    expect((await h.request("POST", "/v1/apps", { session: s, json: { name: "c-app" } })).status).toBe(201);
  });
});

describe("tokens (docs/24-threat-model.md E, \"Leaked CLI or CI token\")", () => {
  test("the value is shown once; the database holds only its hash; last_used_at and the address are recorded", async () => {
    const h = await harness();
    const s = await signup(h, "k@example.test", "t-k");
    const created = await tokenOf(h, s, ["apps:read"]);
    expect(created.token).toMatch(/^renox_pat_[a-z2-7]{32}$/u);
    const list = await h.request("GET", "/v1/tokens", { session: s });
    expect(await list.text()).not.toContain(created.token);
    const dump = JSON.stringify(await h.db.query("select * from tokens"));
    expect(dump).not.toContain(created.token);
    expect(dump).toContain(sha256hex(created.token));
    expect(h.log.lines.join("\n")).not.toContain(created.token);

    h.clock.now += 5000;
    expect((await h.request("GET", "/v1/apps", { token: created.token, ip: "203.0.113.44" })).status).toBe(200);
    const [row] = await h.db.query<{ last_used_at: unknown; last_used_ip: string }>("select last_used_at, last_used_ip from tokens where id = $1", [created.id]);
    expect(Number(row?.last_used_at)).toBe(h.clock.now);
    expect(row?.last_used_ip).toBe("203.0.113.44");
    // docs/24-threat-model.md E: a new token is notified to its user.
    expect(h.mailer.last("k@example.test", "token_created")?.text).toContain(created.id);
  });

  test("expired → 401, revoked → 401, wrong scope → 403, viewer deploying → 403; each audited", async () => {
    const h = await harness();
    await registeredNode(h, "node-1");
    let owner = await signup(h, "o@example.test", "t-o");
    const all = await tokenOf(h, owner, ["*"]);
    expect((await h.request("POST", "/v1/apps", { token: all.token, json: { name: "o-app" } })).status).toBe(201);

    const short = await tokenOf(h, owner, ["apps:read"], 1);
    h.clock.now += DAY_MS;
    expect((await h.request("GET", "/v1/apps", { token: short.token })).status).toBe(401);
    owner = await login(h, "o@example.test"); // the day also ended the idle session

    const revoked = await tokenOf(h, owner, ["apps:read"]);
    expect((await h.request("DELETE", `/v1/tokens/${revoked.id}`, { session: owner })).status).toBe(204);
    expect((await h.request("GET", "/v1/apps", { token: revoked.token })).status).toBe(401);

    const reader = await tokenOf(h, owner, ["apps:read"]);
    expect((await upload(h, reader.token, "o-app", named("o-app"))).status).toBe(403);

    await signup(h, "viewer@example.test");
    const viewerId = await addMember(h, "t-o", "viewer@example.test", "viewer");
    const viewer = await login(h, "viewer@example.test", PASSWORD, { tenant_id: "t-o" });
    const hash = contentHash(named("o-app"));
    expect((await upload(h, all.token, "o-app", named("o-app"))).status).toBe(201);
    expect((await h.request("POST", "/v1/apps/o-app/activate", { session: viewer, json: { hash } })).status).toBe(403);
    expect((await h.request("GET", "/v1/apps/o-app", { session: viewer })).status).toBe(200);

    const listApps = await audit(h, "listApps");
    expect(listApps.map((r) => [r.actor, r.status])).toEqual([
      [`token:${short.id}`, 401],
      [`token:${revoked.id}`, 401],
    ]);
    expect(listApps.every((r) => r.tenant_id === "t-o")).toBe(true);
    expect((await audit(h, "uploadDeployment")).map((r) => [r.actor, r.status])).toEqual([
      [`token:${reader.id}`, 403],
      [`token:${all.id}`, 201],
    ]);
    expect((await audit(h, "activateDeployment")).map((r) => [r.actor, r.status, r.tenant_id])).toEqual([[`user:${viewerId}`, 403, "t-o"]]);
    expect((await audit(h, "createToken")).every((r) => r.status === 201 && /^tok_/u.test(r.target.token_id as string))).toBe(true);
    expect((await audit(h, "revokeToken")).map((r) => r.target.token_id)).toEqual([revoked.id]);
  });

  test("a user's token acts with at most the user's current role, and stops when the user leaves", async () => {
    const h = await harness();
    const owner = await signup(h, "own@example.test", "t-own");
    await h.request("POST", "/v1/apps", { session: owner, json: { name: "own-app" } });
    await signup(h, "dev@example.test");
    const devId = await addMember(h, "t-own", "dev@example.test", "developer");
    const dev = await login(h, "dev@example.test", PASSWORD, { tenant_id: "t-own" });
    // A developer cannot mint what their role lacks.
    const refused = await h.request("POST", "/v1/tokens", { session: dev, json: { name: "x", scopes: ["secrets:write"], expires_in_days: 1 } });
    expect(refused.status).toBe(400);
    expect((await h.request("POST", "/v1/tokens", { session: dev, json: { name: "x", scopes: ["*"], expires_in_days: 1 } })).status).toBe(400);
    const devToken = await tokenOf(h, dev, ["apps:read", "apps:write"]);
    expect((await h.request("GET", "/v1/apps", { token: devToken.token })).status).toBe(200);

    // Demoted to viewer: the token keeps apps:read, loses apps:write.
    expect((await h.request("PUT", `/v1/team/members/${devId}`, { session: owner, json: { role: "viewer" } })).status).toBe(200);
    expect((await h.request("GET", "/v1/apps", { token: devToken.token })).status).toBe(200);
    expect((await h.request("POST", "/v1/apps", { token: devToken.token, json: { name: "dev-app" } })).status).toBe(403);

    // Removed: the token and the session stop working for the tenant.
    expect((await h.request("DELETE", `/v1/team/members/${devId}`, { session: owner })).status).toBe(204);
    expect((await h.request("GET", "/v1/apps", { token: devToken.token })).status).toBe(401);
    expect((await h.request("GET", "/v1/apps", { session: dev })).status).toBe(403);
  });

  test("developers see and revoke only their own tokens; owners see all", async () => {
    const h = await harness();
    const owner = await signup(h, "o2@example.test", "t-o2");
    const ownerToken = await tokenOf(h, owner, ["apps:read"]);
    await signup(h, "d2@example.test");
    await addMember(h, "t-o2", "d2@example.test", "developer");
    const dev = await login(h, "d2@example.test", PASSWORD, { tenant_id: "t-o2" });
    const devToken = await tokenOf(h, dev, ["apps:read"]);
    const ids = async (s: Session) => ((await json(await h.request("GET", "/v1/tokens", { session: s }))).tokens as { id: string }[]).map((t) => t.id);
    expect(await ids(dev)).toEqual([devToken.id]);
    expect((await ids(owner)).sort()).toEqual([ownerToken.id, devToken.id].sort());
    expect((await h.request("DELETE", `/v1/tokens/${ownerToken.id}`, { session: dev })).status).toBe(404);
    expect((await h.request("DELETE", `/v1/tokens/${devToken.id}`, { session: owner })).status).toBe(204);
  });

  test("renox login: device flow from start to a scoped token; pending, approval by a session only, single use", async () => {
    const h = await harness();
    const owner = await signup(h, "cli@example.test", "t-cli");
    const start = await json(await h.request("POST", "/v1/account/device", { json: { name: "laptop" } }));
    expect(start).toMatchObject({ verification_uri: "https://dashboard.renox.test/device", interval: 5, expires_in: 900 });
    const poll = () => h.request("POST", "/v1/account/device/token", { json: { device_code: start.device_code } });
    expect((await poll()).status).toBe(202);
    const asToken = await tokenOf(h, owner, ["tokens:write"]);
    expect((await h.request("POST", "/v1/account/device/approve", { token: asToken.token, json: { user_code: start.user_code } })).status).toBe(403);
    expect((await h.request("POST", "/v1/account/device/approve", { session: owner, json: { user_code: "BBBB-BBBB" } })).status).toBe(404);
    expect((await h.request("POST", "/v1/account/device/approve", { session: owner, json: { user_code: String(start.user_code).toLowerCase(), scopes: ["deploy", "apps:read"] } })).status).toBe(200);
    const done = await poll();
    expect(done.status).toBe(201);
    const token = await json(done);
    expect(token).toMatchObject({ tenant_id: "t-cli", name: "laptop", scopes: ["deploy", "apps:read"] });
    expect((await poll()).status).toBe(404);
    expect((await h.request("GET", "/v1/apps", { token: token.token as string })).status).toBe(200);
    expect(JSON.stringify(await h.db.query("select * from device_codes"))).not.toContain(String(start.device_code));
    // Expired codes cannot be approved.
    const late = await json(await h.request("POST", "/v1/account/device", {}));
    h.clock.now += 15 * 60_000;
    expect((await h.request("POST", "/v1/account/device/approve", { session: await login(h, "cli@example.test"), json: { user_code: late.user_code } })).status).toBe(404);
  });
});

describe("team and roles (docs/24-threat-model.md E, \"Teammate with too much power\")", () => {
  test("viewer and developer cannot write secrets or manage the team; admin can; tokens never manage the team", async () => {
    const h = await harness();
    const owner = await signup(h, "ow@example.test", "t-team");
    await h.request("POST", "/v1/apps", { session: owner, json: { name: "team-app" } });
    const roles: Record<string, Session> = {};
    for (const role of ["admin", "developer", "viewer"]) {
      await signup(h, `${role}@example.test`);
      await addMember(h, "t-team", `${role}@example.test`, role);
      roles[role] = await login(h, `${role}@example.test`, PASSWORD, { tenant_id: "t-team" });
    }
    const put = (s: Session) => h.request("PUT", "/v1/apps/team-app/secrets/API_KEY", { session: s, json: { value: "long enough value" } });
    expect((await put(roles.viewer as Session)).status).toBe(403);
    expect((await put(roles.developer as Session)).status).toBe(403);
    expect((await put(roles.admin as Session)).status).toBe(200);
    expect((await h.request("GET", "/v1/apps/team-app/secrets", { session: roles.viewer as Session })).status).toBe(200);
    const invite = (s: Session) => h.request("POST", "/v1/team/invitations", { session: s, json: { email: "new@example.test", role: "developer" } });
    expect((await invite(roles.developer as Session)).status).toBe(403);
    expect((await invite(roles.admin as Session)).status).toBe(201);
    expect((await h.request("GET", "/v1/team/members", { session: roles.viewer as Session })).status).toBe(200);
    const all = await tokenOf(h, owner, ["*"]);
    expect((await h.request("GET", "/v1/team/members", { token: all.token })).status).toBe(403);
    expect((await audit(h, "putSecret")).map((r) => r.status)).toEqual([403, 403, 200]);
  });

  test("invitation: the invited address accepts once, after verification, with the invited role", async () => {
    const h = await harness();
    const owner = await signup(h, "inv-owner@example.test", "t-inv");
    expect((await h.request("POST", "/v1/team/invitations", { session: owner, json: { email: "joiner@example.test", role: "owner" } })).status).toBe(400);
    expect((await h.request("POST", "/v1/team/invitations", { session: owner, json: { email: "joiner@example.test", role: "developer" } })).status).toBe(201);
    const token = mailToken(h, "joiner@example.test", "invitation");
    const other = await signup(h, "other@example.test");
    expect((await h.request("POST", "/v1/account/invitations/accept", { session: other, json: { token } })).status).toBe(404);
    const joiner = await signup(h, "joiner@example.test");
    expect(await json(await h.request("POST", "/v1/account/invitations/accept", { session: joiner, json: { token } }))).toEqual({ tenant_id: "t-inv", role: "developer" });
    expect((await h.request("POST", "/v1/account/invitations/accept", { session: joiner, json: { token } })).status).toBe(404);
    expect(await json(await h.request("POST", "/v1/account/tenant", { session: joiner, json: { tenant_id: "t-inv" } }))).toEqual({ tenant_id: "t-inv", role: "developer" });
    expect((await h.request("GET", "/v1/apps", { session: joiner })).status).toBe(200);
  });

  test("role changes are audited; the owner's role and removal go only through a transfer", async () => {
    const h = await harness();
    const owner = await signup(h, "rc-owner@example.test", "t-rc");
    await signup(h, "rc-admin@example.test");
    const adminId = await addMember(h, "t-rc", "rc-admin@example.test", "admin");
    const admin = await login(h, "rc-admin@example.test", PASSWORD, { tenant_id: "t-rc" });
    const ownerId = (await json(await h.request("GET", "/v1/account", { session: owner }))).user_id as string;
    expect((await h.request("PUT", `/v1/team/members/${ownerId}`, { session: admin, json: { role: "viewer" } })).status).toBe(409);
    expect((await h.request("DELETE", `/v1/team/members/${ownerId}`, { session: admin })).status).toBe(409);
    expect((await h.request("PUT", `/v1/team/members/${adminId}`, { session: owner, json: { role: "owner" } })).status).toBe(400);
    expect((await h.request("PUT", `/v1/team/members/${adminId}`, { session: owner, json: { role: "developer" } })).status).toBe(200);
    const rows = await audit(h, "changeMemberRole");
    expect(rows.map((r) => [r.status, r.target.user_id, r.target.role])).toEqual([
      [409, ownerId, undefined],
      [400, adminId, undefined],
      [200, adminId, "developer"],
    ]);
    expect(rows.at(-1)?.target.from).toBe("admin");
  });

  test("owner transfer needs both parties: the owner proposes, the new owner accepts", async () => {
    const h = await harness();
    const owner = await signup(h, "t-owner@example.test", "t-tr");
    await signup(h, "t-next@example.test");
    const nextId = await addMember(h, "t-tr", "t-next@example.test", "admin");
    const next = await login(h, "t-next@example.test", PASSWORD, { tenant_id: "t-tr" });
    const ownerId = (await json(await h.request("GET", "/v1/account", { session: owner }))).user_id as string;
    // An admin cannot propose; nobody can accept what was not proposed.
    expect((await h.request("POST", "/v1/team/owner-transfer", { session: next, json: { user_id: nextId } })).status).toBe(403);
    expect((await h.request("POST", "/v1/team/owner-transfer/accept", { session: next })).status).toBe(404);
    expect((await h.request("POST", "/v1/team/owner-transfer", { session: owner, json: { user_id: nextId } })).status).toBe(201);
    expect(h.mailer.last("t-next@example.test", "owner_transfer")).toBeDefined();
    // The proposer cannot accept for the other party.
    expect((await h.request("POST", "/v1/team/owner-transfer/accept", { session: owner })).status).toBe(404);
    const roles = async () => Object.fromEntries((await h.db.query<{ user_id: string; role: string }>("select user_id, role from memberships where tenant_id = 't-tr'")).map((r) => [r.user_id, r.role]));
    expect(await roles()).toEqual({ [ownerId]: "owner", [nextId]: "admin" });
    expect((await h.request("POST", "/v1/team/owner-transfer/accept", { session: next })).status).toBe(200);
    expect(await roles()).toEqual({ [ownerId]: "admin", [nextId]: "owner" });
    expect((await audit(h, "acceptOwnerTransfer")).map((r) => [r.status, r.target.role])).toEqual([
      [404, undefined],
      [404, undefined],
      [200, "owner"],
    ]);
  });
});
