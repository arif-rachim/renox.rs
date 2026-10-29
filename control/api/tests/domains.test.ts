// Custom domains (docs/contracts/deploy-api.md section 10; #59): add,
// TXT verification, DNS checks, certificates, renewal, delivery to nodes.
// DNS and ACME are stubs here; tests/domains-e2e.test.ts runs the same path
// against a local DNS server, Pebble and a TLS worker.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@renox/artifact-validate";
import { checkMessage } from "../src/contract.ts";
import type { CertificateIssuer, IssuedCertificate } from "../src/domains/acme.ts";
import { DirChallengeResponder, MemoryChallengeResponder, type ChallengeResponder } from "../src/domains/challenges.ts";
import { csrDer } from "../src/domains/csr.ts";
import { newCertificateKey } from "../src/domains/csr.ts";
import type { Resolver } from "../src/domains/dns.ts";
import { DNS_CHECK_MS, PENDING_POLL_MS, RENEW_BEFORE_MS, retryAfterMs, tick } from "../src/domains/jobs.ts";
import { configureDomains } from "../src/domains/service.ts";
import { EnvMasterKey } from "../src/secrets/crypto.ts";
import type { RouteSnapshot } from "../src/routes/table.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { selfSigned, StubResolver } from "./domain-stubs.ts";
import { assertScoped, auditRows, createApp_, harness, registeredNode, scopedToken, sseReader, tenant, TEST_MASTER_KEY, type Harness } from "./helpers.ts";

afterEach(assertScoped);

class StubIssuer implements CertificateIssuer {
  readonly orders: string[] = [];
  fail = false;
  days = 90;
  async issue(hostname: string, responder: ChallengeResponder): Promise<IssuedCertificate> {
    this.orders.push(hostname);
    await responder.publish("tok_1", `tok_1.thumb`);
    await responder.remove("tok_1");
    if (this.fail) throw new Error("urn:ietf:params:acme:error:connection");
    return selfSigned(hostname, this.days);
  }
}

const HOST = "www.example.com";
const PLATFORM_HOST = "hello.renox.app";

interface Env {
  h: Harness;
  token: string;
  node: string;
  resolver: StubResolver;
  issuer: StubIssuer;
  hashes: [string, string];
}

const enc = new TextEncoder();
const variant = (n: number) => helloArtifact((_m, f) => f.set("code/n.json", enc.encode(String(n))));

async function setup(): Promise<Env> {
  const h = await harness();
  // A token that outlives the clock jumps of the renewal tests.
  const token = await scopedToken(h, (await tenant(h, "t_hello", "paid"), "t_hello"), ["*"], 365);
  await createApp_(h, token, "hello");
  const node = await registeredNode(h, "node-1");
  const hashes: [string, string] = [contentHash(variant(1)), contentHash(variant(2))];
  for (const n of [1, 2]) expect((await upload(h, token, "hello", variant(n))).status).toBe(201);
  expect((await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash: hashes[0] } })).status).toBe(200);
  const resolver = new StubResolver();
  const issuer = new StubIssuer();
  configureDomains(h.deps, {
    resolver,
    issuer,
    responder: new MemoryChallengeResponder(),
    edge: { hostname: "edge.renox.app", addresses: ["203.0.113.10"] },
    keys: new EnvMasterKey(TEST_MASTER_KEY),
  });
  return { h, token, node, resolver, issuer, hashes };
}

const add = (e: Env, hostname = HOST, token = e.token) => e.h.request("POST", "/v1/apps/hello/domains", { token, json: { hostname } });
const get = async (e: Env, hostname = HOST) => (await (await e.h.request("GET", `/v1/apps/hello/domains/${hostname}`, { token: e.token })).json()) as Record<string, unknown> & { state: string; dns: string; certificate: { state: string; not_after: number | null } };
const snapshotOf = async (e: Env) => (await (await e.h.request("GET", "/v1/nodes/node-1/routes", { token: e.node })).json()) as RouteSnapshot;
const hostEntries = async (e: Env, hostname = HOST) => (await snapshotOf(e)).entries.filter((x) => x.hostname === hostname);

/** Adds the domain, publishes its TXT record and a CNAME to the edge, and runs the job. */
async function verified(e: Env): Promise<void> {
  const body = (await (await add(e)).json()) as { verification: { record_name: string; record_value: string } };
  e.resolver.txts.set(body.verification.record_name, [body.verification.record_value]);
  e.resolver.cnames.set(HOST, "edge.renox.app");
  await tick(e.h.deps);
}

describe("add", () => {
  test("201 pending with the TXT record to create; the contract's Domain schema", async () => {
    const e = await setup();
    const res = await add(e);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ hostname: HOST, app: "hello", state: "pending", dns: "pending", certificate: { state: "none", not_after: null }, verified_at: null });
    expect((body.verification as Record<string, string>).record_name).toBe(`_renox-verify.${HOST}`);
    expect((body.verification as Record<string, string>).record_value).toMatch(/^rnx-verify-[0-9a-z]{26}$/u);
    const list = (await (await e.h.request("GET", "/v1/apps/hello/domains", { token: e.token })).json()) as { domains: unknown[] };
    expect(list.domains).toEqual([body]);
    const [row] = (await auditRows(e.h)).filter((r) => r.action === "addDomain");
    expect(row).toMatchObject({ tenant_id: "t_hello", status: 201, target: { app: "hello", hostname: HOST } });
  });

  test("a hostname of the platform domain is refused; a port is refused by the schema", async () => {
    const e = await setup();
    for (const h of ["renox.app", "other.renox.app", "a.b.renox.app"]) {
      const res = await add(e, h);
      expect(res.status).toBe(400);
    }
    expect((await add(e, "www.example.com:443")).status).toBe(400);
  });

  test("a hostname claimed by another tenant: 409 without the owner", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    const other = await tenant(e.h, "t_other");
    await createApp_(e.h, other, "other");
    const res = await e.h.request("POST", "/v1/apps/other/domains", { token: other, json: { hostname: HOST } });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain('"reason":"not available"');
    expect(text).not.toContain("t_hello");
    expect(text).not.toContain("hello");
  });
});

describe("verification", () => {
  /** docs/23-failure-modes.md "Unverified custom domain": never served before TXT verification. */
  test("an unverified hostname has no route entry, so every node answers 404 for it", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    e.resolver.cnames.set(HOST, "edge.renox.app");
    e.resolver.txts.set(`_renox-verify.${HOST}`, ["rnx-verify-someoneelsestoken000000000"]);
    await tick(e.h.deps);
    expect((await get(e)).state).toBe("pending");
    expect(await hostEntries(e)).toEqual([]);
    expect((await e.h.request("GET", `/v1/nodes/node-1/certificates/${HOST}`, { token: e.node })).status).toBe(404);
    expect(e.issuer.orders).toEqual([]);
  });

  test("the matching TXT record verifies the domain at the next poll; its entries mirror the app's", async () => {
    const e = await setup();
    const body = (await (await add(e)).json()) as { verification: { record_value: string } };
    await tick(e.h.deps);
    e.resolver.txts.set(`_renox-verify.${HOST}`, ["unrelated", body.verification.record_value]);
    // Not due yet: the next lookup is one poll interval later.
    await tick(e.h.deps);
    expect((await get(e)).state).toBe("pending");
    e.h.clock.now += PENDING_POLL_MS;
    await tick(e.h.deps);
    const d = await get(e);
    expect(d.state).toBe("verified");
    expect(d.verified_at).toBe(e.h.clock.now);
    const platform = (await snapshotOf(e)).entries.filter((x) => x.hostname === PLATFORM_HOST);
    const custom = await hostEntries(e);
    expect(custom.map(({ hostname: _h, version: _v, updated_at: _u, ...rest }) => rest)).toEqual(platform.map(({ hostname: _h, version: _v, updated_at: _u, ...rest }) => rest));
    expect(checkMessage("route_snapshot", await snapshotOf(e))).toBeTruthy();
  });

  test("a failed lookup leaves the domain pending", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    e.resolver.failing = true;
    await tick(e.h.deps);
    expect((await get(e)).state).toBe("pending");
  });
});

describe("routes follow the app", () => {
  test("activation of another deployment reaches the custom hostname within one job tick", async () => {
    const e = await setup();
    await verified(e);
    const stream = sseReader(await e.h.request("GET", "/v1/nodes/node-1/stream", { token: e.node }));
    await stream.next();
    expect((await e.h.request("POST", "/v1/apps/hello/activate", { token: e.token, json: { hash: e.hashes[1] } })).status).toBe(200);
    await stream.next();
    await tick(e.h.deps);
    const delta = checkMessage<{ upserts: { hostname: string; deployment_hash: string; status: string }[] }>("route_delta", (await stream.next()).data);
    expect(delta.upserts.filter((u) => u.hostname === HOST).map((u) => [u.deployment_hash, u.status])).toEqual([
      [e.hashes[0], "draining"],
      [e.hashes[1], "active"],
    ]);
    await stream.close();
  });
});

describe("DNS pointing", () => {
  test("not pointing is flagged and pauses renewal; pointing again resumes it", async () => {
    const e = await setup();
    await verified(e);
    expect((await get(e)).dns).toBe("ok");
    expect(e.issuer.orders).toEqual([HOST]);
    e.resolver.cnames.delete(HOST);
    e.resolver.addrs.set(HOST, ["198.51.100.7"]);
    e.h.clock.now += DNS_CHECK_MS;
    await tick(e.h.deps);
    expect((await get(e)).dns).toBe("not_pointing");
    // Inside the renewal window, but the hostname does not point at us: no order.
    e.h.clock.now += 61 * 86_400_000;
    await tick(e.h.deps);
    expect(e.issuer.orders).toEqual([HOST]);
    // Apex style: only edge addresses.
    e.resolver.addrs.set(HOST, ["203.0.113.10"]);
    e.h.clock.now += DNS_CHECK_MS;
    await tick(e.h.deps);
    expect((await get(e)).dns).toBe("ok");
    expect(e.issuer.orders).toEqual([HOST, HOST]);
  });
});

describe("certificates", () => {
  test("issued after verification, stored encrypted, announced to nodes, served to nodes only with no-store", async () => {
    const e = await setup();
    const stream = sseReader(await e.h.request("GET", "/v1/nodes/node-1/stream", { token: e.node }));
    await stream.next();
    await verified(e);
    const d = await get(e);
    expect(d.certificate.state).toBe("issued");
    expect(d.certificate.not_after).toBeGreaterThan(e.h.clock.now);
    let update: unknown;
    for (;;) {
      const m = (await stream.next()).data as { type: string };
      if (m.type === "certificate_update") {
        update = m;
        break;
      }
    }
    expect(checkMessage("certificate_update", update)).toEqual({ type: "certificate_update", schema_version: 0, hostname: HOST, version: 1, not_after: d.certificate.not_after as number });
    expect(JSON.stringify(update)).not.toContain("PRIVATE KEY");

    const res = await e.h.request("GET", `/v1/nodes/node-1/certificates/${HOST}`, { token: e.node });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bundle = checkMessage<{ chain_pem: string; key_pem: string; version: number }>("certificate_bundle", await res.json());
    expect(bundle.version).toBe(1);
    // At rest: no PEM text in any column.
    const rows = await e.h.db.query<Record<string, Uint8Array>>("select chain_cipher, key_cipher from certificates");
    for (const r of rows) for (const v of Object.values(r)) expect(Buffer.from(v).toString("latin1")).not.toContain("-----BEGIN");
    // A tenant token is not a node token.
    expect((await e.h.request("GET", `/v1/nodes/node-1/certificates/${HOST}`, { token: e.token })).status).toBe(401);
    // The served-bundle log line names the hostname, never the key.
    expect(e.h.log.lines.join("\n")).not.toContain("PRIVATE KEY");
    await stream.close();
  });

  test("renewal 30 days before expiry, under a new version", async () => {
    const e = await setup();
    await verified(e);
    const first = (await get(e)).certificate.not_after as number;
    e.h.clock.now = first - RENEW_BEFORE_MS - 1;
    await tick(e.h.deps);
    expect(e.issuer.orders).toEqual([HOST]);
    e.h.clock.now = first - RENEW_BEFORE_MS + 1;
    // DNS is re-checked on the way (one interval has passed).
    await tick(e.h.deps);
    expect(e.issuer.orders).toEqual([HOST, HOST]);
    const bundle = (await (await e.h.request("GET", `/v1/nodes/node-1/certificates/${HOST}`, { token: e.node })).json()) as { version: number };
    expect(bundle.version).toBe(2);
  });

  test("a failed order is retried with backoff; the domain keeps serving", async () => {
    const e = await setup();
    e.issuer.fail = true;
    await verified(e);
    expect((await get(e)).certificate.state).toBe("failed");
    expect((await get(e)).state).toBe("verified");
    await tick(e.h.deps);
    expect(e.issuer.orders).toEqual([HOST]);
    e.h.clock.now += retryAfterMs(1);
    e.issuer.fail = false;
    await tick(e.h.deps);
    expect(e.issuer.orders).toEqual([HOST, HOST]);
    expect((await get(e)).certificate.state).toBe("issued");
    expect(retryAfterMs(2)).toBe(2 * retryAfterMs(1));
    expect(retryAfterMs(20)).toBe(86_400_000);
  });
});

describe("remove", () => {
  test("verified -> detached: entries removed, certificate_remove sent, bundle 404", async () => {
    const e = await setup();
    await verified(e);
    const stream = sseReader(await e.h.request("GET", "/v1/nodes/node-1/stream", { token: e.node }));
    await stream.next();
    const res = await e.h.request("DELETE", `/v1/apps/hello/domains/${HOST}`, { token: e.token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("detached");
    expect(await hostEntries(e)).toEqual([]);
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) seen.push(((await stream.next()).data as { type: string }).type);
    expect(seen.sort()).toEqual(["certificate_remove", "route_delta"]);
    expect((await e.h.request("GET", `/v1/nodes/node-1/certificates/${HOST}`, { token: e.node })).status).toBe(404);
    // Deleting the detached domain releases it, and its certificate is deleted.
    const again = await e.h.request("DELETE", `/v1/apps/hello/domains/${HOST}`, { token: e.token });
    expect(((await again.json()) as { state: string }).state).toBe("released");
    expect(await e.h.db.query("select hostname from certificates")).toEqual([]);
    await stream.close();
  });

  test("pending -> released: gone from the list, claimable by another tenant", async () => {
    const e = await setup();
    expect((await add(e)).status).toBe(201);
    const res = await e.h.request("DELETE", `/v1/apps/hello/domains/${HOST}`, { token: e.token });
    expect(((await res.json()) as { state: string }).state).toBe("released");
    expect((await e.h.request("GET", `/v1/apps/hello/domains/${HOST}`, { token: e.token })).status).toBe(404);
    const other = await tenant(e.h, "t_other");
    await createApp_(e.h, other, "other");
    expect((await e.h.request("POST", "/v1/apps/other/domains", { token: other, json: { hostname: HOST } })).status).toBe(201);
  });
});

describe("pieces", () => {
  test("the CSR verifies with openssl and names the hostname", () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-csr-"));
    const der = csrDer(newCertificateKey(), "shop.example.org");
    writeFileSync(join(dir, "csr.der"), der);
    const out = execFileSync("openssl", ["req", "-inform", "DER", "-in", join(dir, "csr.der"), "-noout", "-verify", "-text"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    // execFileSync throws when openssl reports a verify failure (exit code 1).
    expect(out).toMatch(/CN ?= ?shop\.example\.org/u);
    expect(out).toContain("DNS:shop.example.org");
  });

  test("the directory responder writes only base64url tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renox-acme-"));
    const r = new DirChallengeResponder(dir);
    await r.publish("tok_EN-1", "tok_EN-1.thumb");
    expect(readFileSync(join(dir, "tok_EN-1"), "utf8")).toBe("tok_EN-1.thumb");
    await expect(r.publish("../escape", "x")).rejects.toThrow();
    await r.remove("tok_EN-1");
    expect(() => readFileSync(join(dir, "tok_EN-1"))).toThrow();
  });
});
