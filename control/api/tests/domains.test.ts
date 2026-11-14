// Custom domains through Cloudflare for SaaS (docs/contracts/deploy-api.md
// 0.6 section 10; #59, #419, ADR D25): add, the status poll, routes, remove,
// the 503 without Cloudflare, and the Cloudflare client itself. Cloudflare is
// StubCloudflare here (tests/domain-stubs.ts) or a fake fetch; no test calls
// Cloudflare.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { checkMessage } from "../src/contract.ts";
import { CloudflareCustomHostnames, CloudflareError, fromApi } from "../src/domains/cloudflare.ts";
import { PENDING_POLL_MS, tick } from "../src/domains/jobs.ts";
import { configureDomains } from "../src/domains/service.ts";
import { cloudflareConfig } from "../src/config.ts";
import { stopServing, resumeServing } from "../src/domains/ownership.ts";
import { deltaSince, type RouteDelta, type RouteSnapshot } from "../src/routes/table.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { EDGE, StubCloudflare } from "./domain-stubs.ts";
import { assertScoped, auditRows, createApp_, harness, registeredNode, scopedToken, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const HOST = "www.example.com";
// The harness's platform domain is `renox.app` (tests/helpers.ts).
const PLATFORM_HOST = "hello.renox.app";

interface Env {
  h: Harness;
  token: string;
  node: string;
  cf: StubCloudflare;
  hashes: [string, string];
}

const enc = new TextEncoder();
const variant = (n: number) => helloArtifact((_m, f) => f.set("code/n.json", enc.encode(String(n))));

async function setup(): Promise<Env> {
  const h = await harness();
  const token = await scopedToken(h, (await tenant(h, "t_hello", "paid"), "t_hello"), ["*"], 365);
  await createApp_(h, token, "hello");
  const node = await registeredNode(h, "node-1");
  const hashes: [string, string] = [contentHash(variant(1)), contentHash(variant(2))];
  for (const n of [1, 2]) expect((await upload(h, token, "hello", variant(n))).status).toBe(201);
  expect((await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash: hashes[0] } })).status).toBe(200);
  const cf = new StubCloudflare();
  configureDomains(h.deps, { cloudflare: cf });
  return { h, token, node, cf, hashes };
}

const add = (e: Env, hostname = HOST, token = e.token) => e.h.request("POST", "/v1/apps/hello/domains", { token, json: { hostname } });
type DomainBody = Record<string, unknown> & { state: string; status: string; ssl_status: string; cname_target: string; verification: { purpose: string; type: string; name: string; value: string }[] };
const get = async (e: Env, hostname = HOST) => (await (await e.h.request("GET", `/v1/apps/hello/domains/${hostname}`, { token: e.token })).json()) as DomainBody;
const snapshotOf = async (e: Env) => (await (await e.h.request("GET", "/v1/nodes/node-1/routes", { token: e.node })).json()) as RouteSnapshot;
const hostEntries = async (e: Env, hostname = HOST) => (await snapshotOf(e)).entries.filter((x) => x.hostname === hostname);

/** Adds the domain, lets Cloudflare report it active, and runs the job. */
async function verified(e: Env): Promise<void> {
  expect((await add(e)).status).toBe(201);
  e.cf.setStatus(HOST, "active");
  await tick(e.h.deps);
}

describe("add", () => {
  test("201 pending with Cloudflare's records and the CNAME target; the contract's Domain schema; audited", async () => {
    const e = await setup();
    const res = await add(e);
    expect(res.status).toBe(201);
    const body = (await res.json()) as DomainBody;
    const id = e.cf.of(HOST)?.id as string;
    expect(body).toEqual({
      hostname: HOST,
      app: "hello",
      state: "pending",
      status: "pending",
      ssl_status: "pending_validation",
      cname_target: EDGE,
      verification: [
        { purpose: "ownership", type: "TXT", name: `_cf-custom-hostname.${HOST}`, value: `own-${id}` },
        { purpose: "dcv", type: "TXT", name: `_acme-challenge.${HOST}`, value: `dcv-${id}` },
      ],
      created_at: e.h.clock.now,
      verified_at: null,
      last_checked_at: e.h.clock.now,
    });
    expect(e.cf.calls).toEqual([`create ${HOST}`]);
    const list = (await (await e.h.request("GET", "/v1/apps/hello/domains", { token: e.token })).json()) as { domains: unknown[] };
    expect(list.domains).toEqual([body]);
    const [row] = (await auditRows(e.h)).filter((r) => r.action === "addDomain");
    expect(row).toMatchObject({ tenant_id: "t_hello", status: 201, target: { app: "hello", hostname: HOST } });
  });

  test("no Cloudflare configuration: 503 RENOX_UNAVAILABLE and nothing claimed", async () => {
    const e = await setup();
    configureDomains(e.h.deps, { cloudflare: null });
    const res = await add(e);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("RENOX_UNAVAILABLE");
    expect(text).toContain("custom domains are not configured");
    expect(await e.h.db.query("select 1 from domains")).toEqual([]);
  });

  test("Cloudflare refuses or does not answer: 503, the claim is withdrawn, a later add works", async () => {
    const e = await setup();
    e.cf.failing = true;
    expect((await add(e)).status).toBe(503);
    expect(await e.h.db.query("select 1 from domains")).toEqual([]);
    // The log names the failure, never the token or a header.
    expect(e.h.log.lines.join("\n")).toContain("cloudflare custom hostname not created");
    e.cf.failing = false;
    expect((await add(e)).status).toBe(201);
  });

  test("a hostname of the platform domain is refused; a port is refused by the schema", async () => {
    const e = await setup();
    for (const h of ["renox.app", "other.renox.app", "a.b.renox.app"]) expect((await add(e, h)).status).toBe(400);
    expect((await add(e, "www.example.com:443")).status).toBe(400);
    expect(e.cf.calls).toEqual([]);
  });

  test("a hostname claimed by another tenant: 409 without the owner; Cloudflare is not asked", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    const other = await tenant(e.h, "t_other", "paid");
    await createApp_(e.h, other, "other");
    const res = await e.h.request("POST", "/v1/apps/other/domains", { token: other, json: { hostname: HOST } });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain('"reason":"not available"');
    expect(text).not.toContain("t_hello");
    expect(text).not.toContain("hello");
    expect(e.cf.calls).toEqual([`create ${HOST}`]);
  });
});

describe("verification", () => {
  /** docs/23-failure-modes.md "Unverified custom domain": never served before Cloudflare reports it active. */
  test("a pending custom hostname has no route entry, so every node answers 404 for it", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    e.h.clock.now += PENDING_POLL_MS;
    await tick(e.h.deps);
    expect((await get(e)).state).toBe("pending");
    expect(await hostEntries(e)).toEqual([]);
  });

  test("active verifies the domain at the next poll; its entries mirror the app's; the app lists it", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    await tick(e.h.deps);
    e.cf.setStatus(HOST, "active");
    // Not due yet: the next read is one poll interval after the claim.
    await tick(e.h.deps);
    expect((await get(e)).state).toBe("pending");
    e.h.clock.now += PENDING_POLL_MS;
    await tick(e.h.deps);
    const d = await get(e);
    expect(d).toMatchObject({ state: "verified", status: "active", ssl_status: "active", verification: [], verified_at: e.h.clock.now });
    const strip = (x: RouteSnapshot["entries"][number]) => {
      const { hostname: _h, version: _v, updated_at: _u, ...rest } = x;
      return rest;
    };
    const platform = (await snapshotOf(e)).entries.filter((x) => x.hostname === PLATFORM_HOST);
    expect((await hostEntries(e)).map(strip)).toEqual(platform.map(strip));
    expect(checkMessage("route_snapshot", await snapshotOf(e))).toBeTruthy();
    const app = (await (await e.h.request("GET", "/v1/apps/hello", { token: e.token })).json()) as { hostnames: string[] };
    expect(app.hostnames).toEqual([PLATFORM_HOST, HOST]);
  });

  test("a failed read leaves the domain pending; a hostname Cloudflare lost while pending is created again", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    e.cf.failing = true;
    e.h.clock.now += PENDING_POLL_MS;
    await tick(e.h.deps);
    expect((await get(e)).state).toBe("pending");
    e.cf.failing = false;
    e.cf.forget(HOST);
    e.h.clock.now += PENDING_POLL_MS;
    await tick(e.h.deps);
    // Noticed at this read, created again one poll interval later.
    e.h.clock.now += PENDING_POLL_MS;
    await tick(e.h.deps);
    expect(e.cf.of(HOST)).toBeDefined();
    expect(e.cf.calls.filter((c) => c.startsWith("create"))).toEqual([`create ${HOST}`, `create ${HOST}`]);
  });

  test("rows from before migration 0029 (no custom hostname) get one from the job", async () => {
    const e = await setup();
    await verified(e);
    await e.h.db.query("update domains set cf_hostname_id = null where hostname = $1", [HOST]);
    e.cf.forget(HOST);
    e.h.clock.now += PENDING_POLL_MS;
    await tick(e.h.deps);
    expect(e.cf.of(HOST)).toBeDefined();
    // Still verified and served meanwhile: a pending custom hostname is not a miss.
    e.h.clock.now += 2 * 3_600_000;
    await tick(e.h.deps);
    expect((await get(e)).state).toBe("verified");
    expect((await hostEntries(e)).length).toBeGreaterThan(0);
  });
});

describe("routes follow the app", () => {
  test("activation of another deployment reaches the custom hostname within one job tick", async () => {
    const e = await setup();
    await verified(e);
    expect((await e.h.request("POST", "/v1/apps/hello/activate", { token: e.token, json: { hash: e.hashes[1] } })).status).toBe(200);
    await tick(e.h.deps);
    const entries = await hostEntries(e);
    expect(entries.map((x) => [x.deployment_hash, x.status]).sort()).toEqual(
      [
        [e.hashes[0], "draining"],
        [e.hashes[1], "active"],
      ].sort(),
    );
  });
});

describe("remove", () => {
  test("verified -> detached: entries removed, the custom hostname kept; again -> released and deleted at Cloudflare", async () => {
    const e = await setup();
    await verified(e);
    const res = await e.h.request("DELETE", `/v1/apps/hello/domains/${HOST}`, { token: e.token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("detached");
    expect(await hostEntries(e)).toEqual([]);
    expect(e.cf.of(HOST)).toBeDefined();
    const again = await e.h.request("DELETE", `/v1/apps/hello/domains/${HOST}`, { token: e.token });
    expect(((await again.json()) as { state: string }).state).toBe("released");
    expect(e.cf.of(HOST)).toBeUndefined();
  });

  test("pending -> released: gone from the list, deleted at Cloudflare, claimable by another tenant", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    const res = await e.h.request("DELETE", `/v1/apps/hello/domains/${HOST}`, { token: e.token });
    expect(((await res.json()) as { state: string }).state).toBe("released");
    expect(e.cf.of(HOST)).toBeUndefined();
    expect((await e.h.request("GET", `/v1/apps/hello/domains/${HOST}`, { token: e.token })).status).toBe(404);
    const other = await tenant(e.h, "t_other", "paid");
    await createApp_(e.h, other, "other");
    expect((await e.h.request("POST", "/v1/apps/other/domains", { token: other, json: { hostname: HOST } })).status).toBe(201);
  });

  test("a delete Cloudflare refuses is retried by the job", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    e.cf.failing = true;
    expect((await e.h.request("DELETE", `/v1/apps/hello/domains/${HOST}`, { token: e.token })).status).toBe(200);
    expect(e.cf.of(HOST)).toBeDefined();
    e.cf.failing = false;
    await tick(e.h.deps);
    expect(e.cf.of(HOST)).toBeUndefined();
  });
});

describe("no certificates on the node path", () => {
  test("the node certificate endpoint is gone (ADR D25)", async () => {
    const e = await setup();
    await verified(e);
    expect((await e.h.request("GET", `/v1/nodes/node-1/certificates/${HOST}`, { token: e.node })).status).toBe(404);
  });
});

describe("CONTROL_CF_* (#419)", () => {
  const TOKEN = "abcdefghij0123456789_-xy";
  const ZONE = "0123456789abcdef0123456789abcdef";
  test("all three or none; refusals name the variable and never echo the token", () => {
    expect(cloudflareConfig({})).toBeNull();
    expect(cloudflareConfig({ CONTROL_CF_API_TOKEN: TOKEN, CONTROL_CF_ZONE_ID: ZONE, CONTROL_CF_FALLBACK_ORIGIN: "renoxium.app" })).toEqual({
      apiToken: TOKEN,
      zoneId: ZONE,
      fallbackOrigin: "renoxium.app",
      apiUrl: "https://api.cloudflare.com/client/v4",
    });
    const refuse = (env: Record<string, string>, want: string) => {
      let msg = "";
      try {
        cloudflareConfig(env);
      } catch (e) {
        msg = String(e);
      }
      expect(msg).toContain(want);
      expect(msg).not.toContain(TOKEN);
    };
    refuse({ CONTROL_CF_API_TOKEN: TOKEN }, "CONTROL_CF_ZONE_ID, CONTROL_CF_FALLBACK_ORIGIN");
    refuse({ CONTROL_CF_API_TOKEN: `${TOKEN} x`, CONTROL_CF_ZONE_ID: ZONE, CONTROL_CF_FALLBACK_ORIGIN: "renoxium.app" }, "CONTROL_CF_API_TOKEN is not");
    refuse({ CONTROL_CF_API_TOKEN: TOKEN, CONTROL_CF_ZONE_ID: "zone", CONTROL_CF_FALLBACK_ORIGIN: "renoxium.app" }, "CONTROL_CF_ZONE_ID");
    refuse({ CONTROL_CF_API_TOKEN: TOKEN, CONTROL_CF_ZONE_ID: ZONE, CONTROL_CF_FALLBACK_ORIGIN: "https://edge" }, "CONTROL_CF_FALLBACK_ORIGIN");
    refuse({ CONTROL_CF_API_TOKEN: TOKEN, CONTROL_CF_ZONE_ID: ZONE, CONTROL_CF_FALLBACK_ORIGIN: "renoxium.app", CONTROL_CF_API_URL: "http://cf.example" }, "CONTROL_CF_API_URL");
  });
});

describe("the Cloudflare client", () => {
  const TOKEN = "cf-test-token-0123456789abcdef";
  const ZONE = "0123456789abcdef0123456789abcdef";
  const config = { apiToken: TOKEN, zoneId: ZONE, fallbackOrigin: EDGE, apiUrl: "https://cf.test/client/v4" };
  const api = {
    id: "ch-1",
    hostname: HOST,
    status: "pending",
    ownership_verification: { type: "txt", name: `_cf-custom-hostname.${HOST}`, value: "own-1" },
    ssl: { status: "pending_validation", validation_records: [{ txt_name: `_acme-challenge.${HOST}`, txt_value: "dcv-1" }], validation_errors: [{ message: "CNAME not found" }] },
    verification_errors: ["custom hostname does not CNAME to this zone"],
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("create sends a DV certificate with TXT validation, the bearer token in the header only", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new CloudflareCustomHostnames(config, async (url, init) => {
      seen.push({ url, init });
      return json(200, { success: true, errors: [], result: api });
    });
    const h = await client.create(HOST);
    expect(seen[0]?.url).toBe(`https://cf.test/client/v4/zones/${ZONE}/custom_hostnames`);
    expect(seen[0]?.init.method).toBe("POST");
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ hostname: HOST, ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } } });
    expect(h).toEqual({
      id: "ch-1",
      hostname: HOST,
      status: "pending",
      ssl_status: "pending_validation",
      verification: [
        { purpose: "ownership", type: "TXT", name: `_cf-custom-hostname.${HOST}`, value: "own-1" },
        { purpose: "dcv", type: "TXT", name: `_acme-challenge.${HOST}`, value: "dcv-1" },
      ],
      errors: ["custom hostname does not CNAME to this zone", "CNAME not found"],
    });
  });

  test("a duplicate on our zone is adopted; get answers null on 404; failures throw without the token", async () => {
    let n = 0;
    const client = new CloudflareCustomHostnames(config, async (url, init) => {
      n++;
      if (init.method === "POST") return json(409, { success: false, errors: [{ code: 1406, message: "Duplicate custom hostname found." }] });
      if (url.includes("?hostname=")) return json(200, { success: true, result: [api] });
      if (url.endsWith("/gone")) return json(404, { success: false, errors: [{ code: 1436 }] });
      return json(503, { success: false, errors: [{ code: 10000 }] });
    });
    expect((await client.create(HOST)).id).toBe("ch-1");
    expect(n).toBe(2);
    expect(await client.get("gone")).toBeNull();
    let err: unknown;
    try {
      await client.get("ch-1");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CloudflareError);
    expect(String(err)).toContain("HTTP 503");
    expect(String(err)).not.toContain(TOKEN);
    // A delete of a hostname already gone is not an error.
    await client.delete("gone");
  });

  test("a network failure is a CloudflareError that names no URL, header or token", async () => {
    const client = new CloudflareCustomHostnames(config, async () => {
      throw new TypeError(`fetch failed: Bearer ${TOKEN}`);
    });
    let err: unknown;
    try {
      await client.get("ch-1");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CloudflareError);
    expect(String(err)).not.toContain(TOKEN);
  });

  test("odd statuses are kept as unknown, never passed through", () => {
    expect(fromApi({ id: "x", hostname: HOST, status: "Active; drop table" }).status).toBe("unknown");
    expect(fromApi({ id: "x", hostname: HOST }).ssl_status).toBe("unknown");
  });
});

describe("module_config.email.app_url (0.12, #826)", () => {
  const OTHER = "shop.example.com";
  const email = (config: Record<string, unknown>) => ({ modules: [{ name: "email", config }] });

  /** Stores `extra` in the manifest of the second deployment and activates it. */
  async function activateWith(e: Env, extra: Record<string, unknown>): Promise<void> {
    await e.h.db.query("update deployments set manifest = manifest || $1::text::jsonb where app = 'hello' and hash = $2", [JSON.stringify(extra), e.hashes[1]]);
    const res = await e.h.request("POST", "/v1/apps/hello/activate", { token: e.token, json: { hash: e.hashes[1] } });
    expect(res.status).toBe(200);
    await tick(e.h.deps);
  }
  const activeOf = async (e: Env, hostname: string) => (await hostEntries(e, hostname)).find((x) => x.status === "active");
  const urlOf = async (e: Env, hostname: string) => (await activeOf(e, hostname))?.module_config;
  const lastVersion = async (e: Env) => (await snapshotOf(e)).version;
  /** The delta after `since`, which must pass the contract's schema. */
  const deltaAfter = async (e: Env, since: number) => checkMessage<RouteDelta>("route_delta", await deltaSince(e.h.db, since));
  const platformUrl = { email: { app_url: `https://${PLATFORM_HOST}` } };

  test("an empty app_url gets the platform host on activation; the previous deployment's entry has none", async () => {
    const e = await setup();
    const since = await lastVersion(e);
    await activateWith(e, email({ app_url: "" }));
    expect(await urlOf(e, PLATFORM_HOST)).toEqual(platformUrl);
    const delta = await deltaAfter(e, since);
    expect(delta.upserts.find((u) => u.hostname === PLATFORM_HOST && u.status === "active")?.module_config).toEqual(platformUrl);
    expect((await hostEntries(e, PLATFORM_HOST)).find((x) => x.status === "draining")?.module_config).toBeUndefined();
  });

  test("a verified custom domain moves it, with no new deployment; removing it moves it back", async () => {
    const e = await setup();
    await activateWith(e, email({}));
    expect(await urlOf(e, PLATFORM_HOST)).toEqual(platformUrl);
    let since = await lastVersion(e);
    await verified(e);
    const custom = { email: { app_url: `https://${HOST}` } };
    expect(await urlOf(e, PLATFORM_HOST)).toEqual(custom);
    expect(await urlOf(e, HOST)).toEqual(custom);
    let delta = await deltaAfter(e, since);
    expect(delta.upserts.filter((u) => u.status === "active").map((u) => [u.hostname, u.module_config]).sort()).toEqual(
      [
        [HOST, custom],
        [PLATFORM_HOST, custom],
      ].sort(),
    );
    since = await lastVersion(e);
    expect((await e.h.request("DELETE", `/v1/apps/hello/domains/${HOST}`, { token: e.token })).status).toBe(200);
    expect(await hostEntries(e)).toEqual([]);
    expect(await urlOf(e, PLATFORM_HOST)).toEqual(platformUrl);
    delta = await deltaAfter(e, since);
    expect(delta.upserts.find((u) => u.hostname === PLATFORM_HOST && u.status === "active")?.module_config).toEqual(platformUrl);
    expect(delta.removals.map((r) => r.hostname)).toContain(HOST);
  });

  test("with two verified domains it is the platform host; one removed, the other is primary again", async () => {
    const e = await setup();
    await activateWith(e, email({ app_url: "" }));
    await verified(e);
    expect((await add(e, OTHER)).status).toBe(201);
    e.cf.setStatus(OTHER, "active");
    const since = await lastVersion(e);
    await tick(e.h.deps);
    for (const h of [PLATFORM_HOST, HOST, OTHER]) expect(await urlOf(e, h)).toEqual(platformUrl);
    await deltaAfter(e, since);
    expect((await e.h.request("DELETE", `/v1/apps/hello/domains/${OTHER}`, { token: e.token })).status).toBe(200);
    const custom = { email: { app_url: `https://${HOST}` } };
    for (const h of [PLATFORM_HOST, HOST]) expect(await urlOf(e, h)).toEqual(custom);
  });

  test("a domain detached by misses and verified again moves the value both ways", async () => {
    const e = await setup();
    await activateWith(e, email({}));
    await verified(e);
    await e.h.db.query("update domains set state = 'detached', detach_reason = 'unverified', detached_at = $2 where hostname = $1", [HOST, e.h.clock.now]);
    const d = { hostname: HOST, tenant_id: "t_hello", app: "hello" };
    await stopServing(e.h.deps, d);
    expect(await urlOf(e, PLATFORM_HOST)).toEqual(platformUrl);
    await e.h.db.query("update domains set state = 'verified', detach_reason = null, detached_at = null where hostname = $1", [HOST]);
    await resumeServing(e.h.deps, d);
    expect(await urlOf(e, PLATFORM_HOST)).toEqual({ email: { app_url: `https://${HOST}` } });
  });

  test("an explicit app_url, or no email module, gets no module_config", async () => {
    const e = await setup();
    await activateWith(e, email({ app_url: "https://x.example" }));
    await verified(e);
    for (const h of [PLATFORM_HOST, HOST]) expect((await activeOf(e, h))?.module_config).toBeUndefined();
    const plain = await setup();
    await verified(plain);
    for (const h of [PLATFORM_HOST, HOST]) expect((await activeOf(plain, h))?.module_config).toBeUndefined();
    expect(checkMessage("route_snapshot", await snapshotOf(plain))).toBeTruthy();
  });
});
