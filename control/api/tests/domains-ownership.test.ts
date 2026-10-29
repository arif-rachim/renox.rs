// Domain ownership, re-verification and slug quarantine (#114;
// docs/24-threat-model.md section C, "Custom domain takeover" and
// "Shared-domain reputation"; deploy-api.md section 10).

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { checkMessage } from "../src/contract.ts";
import { QUARANTINE_MS, RESERVED_SLUGS, slugState } from "../src/apps/slugs.ts";
import { MemoryChallengeResponder } from "../src/domains/challenges.ts";
import { tick } from "../src/domains/jobs.ts";
import { HOLD_MS, isUniqueViolation } from "../src/domains/ownership.ts";
import { RECHECK_MS, REVERIFY_MS } from "../src/domains/reverify.ts";
import { configureDomains } from "../src/domains/service.ts";
import { EnvMasterKey } from "../src/secrets/crypto.ts";
import { SESSION_COOKIE } from "../src/auth/sessions.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { selfSigned, StubResolver } from "./domain-stubs.ts";
import { assertScoped, auditRows, createApp_, harness, PASSWORD, registeredNode, sseReader, signup, TEST_MASTER_KEY, type Harness } from "./helpers.ts";
import type { CertificateIssuer } from "../src/domains/acme.ts";

afterEach(assertScoped);

const HOST = "www.example.com";

class CountingIssuer implements CertificateIssuer {
  readonly orders: string[] = [];
  async issue(hostname: string) {
    this.orders.push(hostname);
    return selfSigned(hostname, 90);
  }
}

interface Tenant {
  id: string;
  email: string;
  token: string;
}

/** A tenant with a signed-up owner and a `*` token valid for a year. */
async function owner(h: Harness, id: string, app: string): Promise<Tenant> {
  const email = `owner@${id}.test`;
  const session = await signup(h, email, id);
  const res = await h.request("POST", "/v1/tokens", { session, json: { name: "t", scopes: ["*"], expires_in_days: 365 } });
  const token = ((await res.json()) as { token: string }).token;
  await createApp_(h, token, app);
  return { id, email, token };
}

interface Env {
  h: Harness;
  a: Tenant;
  b: Tenant;
  resolver: StubResolver;
  issuer: CountingIssuer;
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
  const resolver = new StubResolver();
  const issuer = new CountingIssuer();
  configureDomains(h.deps, { resolver, issuer, responder: new MemoryChallengeResponder(), edge: { hostname: "edge.renox.app", addresses: [] }, keys: new EnvMasterKey(TEST_MASTER_KEY) });
  return { h, a, b, resolver, issuer, node };
}

const add = (e: Env, t: Tenant, app: string, hostname = HOST) => e.h.request("POST", `/v1/apps/${app}/domains`, { token: t.token, json: { hostname } });
const stateOf = async (e: Env, hostname = HOST) =>
  (await e.h.db.query<{ state: string; tenant_id: string; detach_reason: string | null }>("select state, tenant_id, detach_reason from domains where hostname = $1 and state <> 'released'", [hostname]))[0];
const entries = async (e: Env, hostname = HOST) => e.h.db.query("select deployment_hash from route_entries where hostname = $1", [hostname]);

/** A verified domain of tenant A's app with a certificate. */
async function verifiedA(e: Env): Promise<string> {
  const body = (await (await add(e, e.a, "alpha")).json()) as { verification: { record_name: string; record_value: string } };
  e.resolver.txts.set(body.verification.record_name, [body.verification.record_value]);
  e.resolver.cnames.set(HOST, "edge.renox.app");
  await tick(e.h.deps);
  expect((await stateOf(e))?.state).toBe("verified");
  expect(e.issuer.orders).toEqual([HOST]);
  return body.verification.record_name;
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
      e.h.db.query("insert into domains (id, hostname, tenant_id, app, state, verify_token, created_at, next_check_at) values ('dom_x', $1, 't-b', 'beta', 'pending', 'rnx-verify-00000000000000000000000000', 0, 0)", [HOST]),
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
    // The CNAME still points at Renox: inside the window nobody else may take it.
    e.h.clock.now = detachedAt + HOLD_MS - 1;
    await tick(e.h.deps);
    expect((await add(e, e.b, "beta")).status).toBe(409);
    // A removed domain is not re-verified on its own, even though its record is still there.
    expect((await stateOf(e))?.state).toBe("detached");
    e.h.clock.now = detachedAt + HOLD_MS;
    await tick(e.h.deps);
    expect(await stateOf(e)).toBeUndefined();
    expect(await e.h.db.query("select hostname from certificates")).toEqual([]);
    expect((await auditRows(e.h)).filter((r) => r.action === "releaseDomain")).toMatchObject([{ tenant_id: "t-a", actor: "domain-job" }]);
    expect((await add(e, e.b, "beta")).status).toBe(201);
  });

  test("the owner can release at once, or take it back and have it re-verified", async () => {
    const e = await setup();
    await verifiedA(e);
    await e.h.request("DELETE", `/v1/apps/alpha/domains/${HOST}`, { token: e.a.token });
    // Taken back: detached until the job sees the record, then verified and served.
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

describe("re-verification", () => {
  test("TXT removed: serving stops within one interval, owner emailed, audited; restored: serving resumes", async () => {
    const e = await setup();
    const record = await verifiedA(e);
    const stream = sseReader(await e.h.request("GET", "/v1/nodes/node-1/stream", { token: e.node }));
    await stream.next();

    e.resolver.txts.delete(record);
    e.h.clock.now += REVERIFY_MS - 1;
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
    e.h.clock.now += 1;
    await tick(e.h.deps);
    expect(await stateOf(e)).toMatchObject({ state: "detached", detach_reason: "unverified" });
    expect(await entries(e)).toEqual([]);
    const types: string[] = [];
    for (let i = 0; i < 2; i++) types.push(((await stream.next()).data as { type: string }).type);
    expect(types.sort()).toEqual(["certificate_remove", "route_delta"]);
    const mail = e.h.mailer.last(e.a.email, "domain_detached");
    expect(mail?.subject).toContain(HOST);
    expect((await auditRows(e.h)).filter((r) => r.action === "detachDomain")).toMatchObject([{ tenant_id: "t-a", actor: "domain-job", target: { hostname: HOST, reason: "txt record missing" } }]);
    // Still owned: another tenant cannot take it while it is detached.
    expect((await add(e, e.b, "beta")).status).toBe(409);

    // Back within the hour.
    e.resolver.txts.set(record, [(await e.h.db.query<{ verify_token: string }>("select verify_token from domains where hostname = $1", [HOST]))[0]?.verify_token as string]);
    e.h.clock.now += RECHECK_MS;
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
    expect(await entries(e)).toHaveLength(1);
    const back: { type: string }[] = [];
    for (let i = 0; i < 2; i++) back.push((await stream.next()).data as { type: string });
    const update = back.find((m) => m.type === "certificate_update");
    expect(checkMessage<{ version: number }>("certificate_update", update).version).toBeGreaterThan(2);
    expect((await auditRows(e.h)).filter((r) => r.action === "reverifyDomain")).toMatchObject([{ tenant_id: "t-a", actor: "domain-job" }]);
    // The stored certificate was reused; no new order.
    expect(e.issuer.orders).toEqual([HOST]);
    await stream.close();
  });

  test("a failed lookup is not a missing record", async () => {
    const e = await setup();
    await verifiedA(e);
    e.resolver.failing = true;
    e.h.clock.now += REVERIFY_MS;
    await tick(e.h.deps);
    expect((await stateOf(e))?.state).toBe("verified");
    e.resolver.failing = false;
  });

  test("checked before every certificate order: a missing record detaches instead of ordering", async () => {
    const e = await setup();
    const record = await verifiedA(e);
    const notAfter = (await e.h.db.query<{ not_after: unknown }>("select not_after from certificates"))[0]?.not_after;
    e.resolver.txts.delete(record);
    // Inside the renewal window but before the 7-day re-check is due.
    await e.h.db.query("update domains set next_txt_check_at = $1", [Number(notAfter) + REVERIFY_MS]);
    e.h.clock.now = Number(notAfter) - 29 * 86_400_000;
    await tick(e.h.deps);
    expect(e.issuer.orders).toEqual([HOST]);
    expect((await stateOf(e))?.state).toBe("detached");
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
