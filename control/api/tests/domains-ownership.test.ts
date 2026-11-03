// Domain ownership, the status poll and slug quarantine (#114, #419;
// docs/24-threat-model.md section C, "Custom domain takeover" and
// "Shared-domain reputation"; deploy-api.md 0.6 section 10). Cloudflare is
// StubCloudflare (tests/domain-stubs.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { QUARANTINE_MS, RESERVED_SLUGS, slugState } from "../src/apps/slugs.ts";
import { tick } from "../src/domains/jobs.ts";
import { HOLD_MS, isUniqueViolation } from "../src/domains/ownership.ts";
import { DETACH_GRACE_MS, DETACH_MISSES, MISS_RECHECK_MS, RECHECK_MS, REVERIFY_MS, verdictOf } from "../src/domains/reverify.ts";
import { configureDomains } from "../src/domains/service.ts";
import { SESSION_COOKIE } from "../src/auth/sessions.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { StubCloudflare } from "./domain-stubs.ts";
import { assertScoped, auditRows, createApp_, harness, PASSWORD, registeredNode, signup, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const HOST = "www.example.com";

interface Tenant {
  id: string;
  email: string;
  token: string;
}

/** A tenant with a signed-up owner and a `*` token valid for a year. */
async function owner(h: Harness, id: string, app: string): Promise<Tenant> {
  const email = `owner@${id}.test`;
  const session = await signup(h, email, id);
  // Past its first 7 days: a new free tenant has no custom domain (deploy-api.md 0.5 section 21).
  await h.db.query("update tenants set created_at = created_at - $2 where id = $1", [id, 8 * 86_400_000]);
  const res = await h.request("POST", "/v1/tokens", { session, json: { name: "t", scopes: ["*"], expires_in_days: 365 } });
  const token = ((await res.json()) as { token: string }).token;
  await createApp_(h, token, app);
  return { id, email, token };
}

interface Env {
  h: Harness;
  a: Tenant;
  b: Tenant;
  cf: StubCloudflare;
  node: string;
}

async function setup(): Promise<Env> {
  const h = await harness();
  const a = await owner(h, "t-a", "alpha");
  const b = await owner(h, "t-b", "beta");
  const node = await registeredNode(h, "node-1");
  const files = helloArtifact((m) => ((m.app as Record<string, unknown>).name = "alpha"));
  expect((await upload(h, a.token, "alpha", files)).status).toBe(201);
  expect((await h.request("POST", "/v1/apps/alpha/activate", { token: a.token, json: { hash: contentHash(files) } })).status).toBe(200);
  const cf = new StubCloudflare();
  configureDomains(h.deps, { cloudflare: cf });
  return { h, a, b, cf, node };
}

const add = (e: Env, t: Tenant, app: string, hostname = HOST) => e.h.request("POST", `/v1/apps/${app}/domains`, { token: t.token, json: { hostname } });
const stateOf = async (e: Env, hostname = HOST) =>
  (await e.h.db.query<{ state: string; tenant_id: string; detach_reason: string | null }>("select state, tenant_id, detach_reason from domains where hostname = $1 and state <> 'released'", [hostname]))[0];
const entries = async (e: Env, hostname = HOST) => e.h.db.query("select deployment_hash from route_entries where hostname = $1", [hostname]);
const misses = async (e: Env) => (await e.h.db.query<{ cf_misses: unknown; cf_first_miss_at: unknown }>("select cf_misses, cf_first_miss_at from domains where hostname = $1 and state <> 'released'", [HOST]))[0];

/** A verified domain of tenant A's app. */
async function verifiedA(e: Env): Promise<void> {
  expect((await add(e, e.a, "alpha")).status).toBe(201);
  e.cf.setStatus(HOST, "active");
  await tick(e.h.deps);
  expect((await stateOf(e))?.state).toBe("verified");
}

describe("one owner per hostname", () => {
  /** docs/24-threat-model.md C "Custom domain takeover": a hostname is owned by at most one tenant. */
  test("two tenants racing for one hostname: exactly one owns it, the other gets 409 without the owner's name", async () => {
    const e = await setup();
    const [ra, rb] = await Promise.all([add(e, e.a, "alpha"), add(e, e.b, "beta")]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    const text = await loser.text();
    expect(text).toContain('"reason":"not available"');
    for (const leak of ["t-a", "t-b", "alpha", "beta"]) expect(text).not.toContain(leak);
    expect(await e.h.db.query("select tenant_id from domains where hostname = $1 and state <> 'released'", [HOST])).toHaveLength(1);
  });

  test("the database refuses a second claim even past the API check (unique index)", async () => {
    const e = await setup();
    expect((await add(e, e.a, "alpha")).status).toBe(201);
    await expect(
      e.h.db.query("insert into domains (id, hostname, tenant_id, app, state, created_at, next_check_at) values ('dom_x', $1, 't-b', 'beta', 'pending', 0, 0)", [HOST]),
    ).rejects.toThrow();
  });

  test("a unique violation from either driver is recognised (the race lost at the index answers 409)", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "ERR_POSTGRES_SERVER_ERROR", errno: "23503" })).toBe(false);
  });

  test("the owner adding it again: 409 already added", async () => {
    const e = await setup();
    expect((await add(e, e.a, "alpha")).status).toBe(201);
    const res = await add(e, e.a, "alpha");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("already added");
  });
});

describe("removal keeps ownership for 30 days", () => {
  test("detached: another tenant is refused for 30 days, then the hostname is released and claimable", async () => {
    const e = await setup();
    await verifiedA(e);
    expect((await e.h.request("DELETE", `/v1/apps/alpha/domains/${HOST}`, { token: e.a.token })).status).toBe(200);
    expect(await stateOf(e)).toMatchObject({ state: "detached", detach_reason: "removed" });
    expect(await entries(e)).toEqual([]);
    const detachedAt = e.h.clock.now;
    // The CNAME still points at Renoxium: inside the window nobody else may take it.
    e.h.clock.now = detachedAt + HOLD_MS - 1;
    await tick(e.h.deps);
    expect((await add(e, e.b, "beta")).status).toBe(409);
    // A removed domain is not re-verified on its own, even though Cloudflare still reports it active.
    expect((await stateOf(e))?.state).toBe("detached");
    e.h.clock.now = detachedAt + HOLD_MS;
    await tick(e.h.deps);
    expect(await stateOf(e)).toBeUndefined();
    // Released: the custom hostname is deleted at Cloudflare.
    expect(e.cf.of(HOST)).toBeUndefined();
    expect((await auditRows(e.h)).filter((r) => r.action === "releaseDomain")).toMatchObject([{ tenant_id: "t-a", actor: "domain-job" }]);
    expect((await add(e, e.b, "beta")).status).toBe(201);
  });

  test("the owner can release at once, or take it back and have it re-verified", async () => {
    const e = await setup();
    await verifiedA(e);
    await e.h.request("DELETE", `/v1/apps/alpha/domains/${HOST}`, { token: e.a.token });
    // Taken back: detached until the job reads the custom hostname, then verified and served.
    const back = await add(e, e.a, "alpha");
    expect(back.status).toBe(201);
    expect(((await back.json()) as { state: string }).state).toBe("detached");
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
    expect(await entries(e)).toHaveLength(1);
    // Released by its owner: claimable at once.
    await e.h.request("DELETE", `/v1/apps/alpha/domains/${HOST}`, { token: e.a.token });
    const released = await e.h.request("DELETE", `/v1/apps/alpha/domains/${HOST}`, { token: e.a.token });
    expect(((await released.json()) as { state: string }).state).toBe("released");
    expect((await add(e, e.b, "beta")).status).toBe(201);
  });
});

describe("the status poll (#398 rule)", () => {
  test("verdicts: active is a match; moved, deleted, blocked or not found a miss; anything else unknown", () => {
    const h = (status: string) => ({ id: "x", hostname: HOST, status, ssl_status: "active", verification: [], errors: [] });
    expect(verdictOf(h("active"))).toBe("match");
    for (const s of ["moved", "deleted", "blocked", "pending_deletion", "pending_blocked"]) expect(verdictOf(h(s))).toBe("miss");
    expect(verdictOf(null)).toBe("miss");
    for (const s of ["pending", "test_pending", "unknown", "provisioned"]) expect(verdictOf(h(s))).toBe("unknown");
  });

  /** docs/24-threat-model.md C "Custom domain takeover": a hostname that stopped pointing at us stops being served. */
  test("moved: serving stops after consecutive misses over the grace period, owner emailed, audited; active again: serving resumes", async () => {
    const e = await setup();
    await verifiedA(e);
    e.cf.setStatus(HOST, "moved");
    e.h.clock.now += REVERIFY_MS - 1;
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
    e.h.clock.now += 1;
    const firstMiss = e.h.clock.now;
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
    e.h.clock.now += MISS_RECHECK_MS;
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
    expect(e.h.mailer.last(e.a.email, "domain_detached")).toBeUndefined();
    e.h.clock.now = firstMiss + DETACH_GRACE_MS;
    await tick(e.h.deps);
    expect(await stateOf(e)).toMatchObject({ state: "detached", detach_reason: "unverified" });
    expect(await entries(e)).toEqual([]);
    const mail = e.h.mailer.last(e.a.email, "domain_detached");
    expect(mail?.subject).toContain(HOST);
    expect(mail?.text).toContain('"moved"');
    expect((await auditRows(e.h)).filter((r) => r.action === "detachDomain")).toMatchObject([{ tenant_id: "t-a", actor: "domain-job", target: { hostname: HOST, reason: "cloudflare status moved" } }]);
    // Still owned: another tenant cannot take it while it is detached.
    expect((await add(e, e.b, "beta")).status).toBe(409);

    // Back within the hour.
    e.cf.setStatus(HOST, "active");
    e.h.clock.now += RECHECK_MS;
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
    expect(await entries(e)).toHaveLength(1);
    expect((await auditRows(e.h)).filter((r) => r.action === "reverifyDomain")).toMatchObject([{ tenant_id: "t-a", actor: "domain-job" }]);
  });

  /** The #398 lesson for the poll: an API error is unknown, never a miss. */
  test("Cloudflare errors for hours never detach and are not counted", async () => {
    const e = await setup();
    await verifiedA(e);
    e.cf.failing = true;
    for (let i = 0; i < 6; i++) {
      e.h.clock.now += REVERIFY_MS;
      await tick(e.h.deps);
    }
    expect((await stateOf(e))?.state).toBe("verified");
    expect(Number((await misses(e))?.cf_misses)).toBe(0);
    expect(await entries(e)).toHaveLength(1);
    e.cf.failing = false;
  });

  test("one negative answer, then active: no detach, the count is reset", async () => {
    const e = await setup();
    await verifiedA(e);
    e.cf.setStatus(HOST, "moved");
    e.h.clock.now += REVERIFY_MS;
    await tick(e.h.deps);
    expect(Number((await misses(e))?.cf_misses)).toBe(1);
    e.cf.setStatus(HOST, "active");
    e.h.clock.now += DETACH_GRACE_MS;
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
    const after = await misses(e);
    expect(Number(after?.cf_misses)).toBe(0);
    expect(after?.cf_first_miss_at).toBeNull();
    expect(e.h.mailer.last(e.a.email, "domain_detached")).toBeUndefined();
    expect((await auditRows(e.h)).filter((r) => r.action === "detachDomain")).toEqual([]);
  });

  test("an error between misses neither counts nor resets; a pending status is not a miss", async () => {
    const e = await setup();
    await verifiedA(e);
    e.cf.setStatus(HOST, "pending");
    e.h.clock.now += REVERIFY_MS;
    await tick(e.h.deps);
    expect(Number((await misses(e))?.cf_misses)).toBe(0);
    e.cf.setStatus(HOST, "deleted");
    e.h.clock.now += REVERIFY_MS;
    await tick(e.h.deps);
    e.cf.failing = true;
    e.h.clock.now += MISS_RECHECK_MS;
    await tick(e.h.deps);
    expect(Number((await misses(e))?.cf_misses)).toBe(1);
    e.cf.failing = false;
  });

  test("three quick misses do not detach before the grace period has passed", async () => {
    const e = await setup();
    await verifiedA(e);
    e.cf.forget(HOST);
    e.h.clock.now += REVERIFY_MS;
    const firstMiss = e.h.clock.now;
    // Force the reads as fast as the job allows them.
    for (let i = 0; i < DETACH_MISSES + 2; i++) {
      await e.h.db.query("update domains set next_check_at = $1 where state = 'verified'", [e.h.clock.now]);
      await tick(e.h.deps);
      e.h.clock.now += 60_000;
    }
    expect(e.h.clock.now - firstMiss).toBeLessThan(DETACH_GRACE_MS);
    expect((await stateOf(e))?.state).toBe("verified");
    e.h.clock.now = firstMiss + DETACH_GRACE_MS;
    await e.h.db.query("update domains set next_check_at = $1 where state = 'verified'", [e.h.clock.now]);
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("detached");
  });

  test("POST …/domains on the owner's own detached claim forces a read at the next tick", async () => {
    const e = await setup();
    await verifiedA(e);
    e.cf.setStatus(HOST, "moved");
    e.h.clock.now += REVERIFY_MS;
    const firstMiss = e.h.clock.now;
    for (let i = 0; i < DETACH_MISSES; i++) {
      e.h.clock.now = firstMiss + i * MISS_RECHECK_MS;
      await tick(e.h.deps);
    }
    expect((await stateOf(e))?.state).toBe("detached");
    e.cf.setStatus(HOST, "active");
    // Without the POST the next read is up to RECHECK_MS away.
    e.h.clock.now += 1_000;
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("detached");
    const res = await add(e, e.a, "alpha");
    expect(res.status).toBe(201);
    // The same custom hostname: Cloudflare is not asked to create another.
    expect(e.cf.calls.filter((c) => c.startsWith("create"))).toEqual([`create ${HOST}`]);
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
  });
});

describe("app slugs", () => {
  test("reserved names are refused with the same 409 as a name in use; the list matches the database", async () => {
    const e = await setup();
    for (const name of ["www", "api", "admin", "dashboard", "mcp", "acme"]) {
      const res = await e.h.request("POST", "/v1/apps", { token: e.a.token, json: { name } });
      expect(res.status).toBe(409);
      expect(await res.text()).toContain('"reason":"not available"');
    }
    const db = (await e.h.db.query<{ s: string }>("select reserved_slugs() as s")).map((r) => r.s);
    expect(db.sort()).toEqual([...RESERVED_SLUGS].sort());
  });

  test("a deleted app's name is quarantined for 90 days for other tenants; its own tenant may reuse it", async () => {
    const e = await setup();
    await e.h.db.query("delete from secret_sets where app = 'beta'");
    await e.h.db.query("delete from apps where name = 'beta'");
    const [q] = await e.h.db.query<{ tenant_id: string; until: unknown; created_at: unknown }>("select tenant_id, until, created_at from quarantined_slugs where slug = 'beta'");
    expect(q?.tenant_id).toBe("t-b");
    const until = Number(q?.until);
    expect(until - Number(q?.created_at)).toBe(QUARANTINE_MS);

    e.h.clock.now = until - 1;
    expect(await slugState(e.h.db, "beta", "t-a", e.h.clock.now)).toBe("quarantined");
    expect((await e.h.request("POST", "/v1/apps", { token: e.a.token, json: { name: "beta" } })).status).toBe(409);
    expect(await slugState(e.h.db, "beta", "t-b", e.h.clock.now)).toBe("available");
    e.h.clock.now = until;
    expect(await slugState(e.h.db, "beta", "t-a", e.h.clock.now)).toBe("available");
    expect((await e.h.request("POST", "/v1/apps", { token: e.a.token, json: { name: "beta" } })).status).toBe(201);
  });

  test("its own tenant may take the name back inside the window", async () => {
    const e = await setup();
    await e.h.db.query("delete from secret_sets where app = 'beta'");
    await e.h.db.query("delete from apps where name = 'beta'");
    expect((await e.h.request("POST", "/v1/apps", { token: e.b.token, json: { name: "beta" } })).status).toBe(201);
    expect(await slugState(e.h.db, "www", "t-a", 0)).toBe("reserved");
  });
});

describe("Public Suffix List: no cookie on the apex", () => {
  /**
   * docs/24-threat-model.md C "Shared-domain reputation": until renox.app is
   * on the PSL, platform cookies behave as if it were. The control plane's
   * session cookie is `__Host-`: host-only, Path=/, no Domain, so it never
   * reaches renox.app or another tenant's subdomain.
   */
  test("the session cookie is host-only", async () => {
    const h = await harness();
    await signup(h, "psl@t.test", "t-psl");
    const res = await h.request("POST", "/v1/account/login", { json: { email: "psl@t.test", password: PASSWORD } });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) as string;
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    expect(cookie).toMatch(/;\s*Path=\/(;|$)/iu);
    expect(cookie).toMatch(/;\s*Secure(;|$)/iu);
    expect(cookie).not.toMatch(/;\s*Domain=/iu);
  });
});
