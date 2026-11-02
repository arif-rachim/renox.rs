// The client address behind a trusted proxy (#366 scope 1). On the single host
// the public listener is reached only through `cloudflared` on loopback, so
// every socket peer is 127.0.0.1: without the header the per-IP buckets would
// be one bucket for everyone. These tests prove the header is believed only
// from a listed peer, and that the login and sign-up buckets key on the result
// (docs/24-threat-model.md: "Login brute force, credential stuffing,
// enumeration"; "Bot signups").

import { afterEach, describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { behindProxies, headerAddress, normalizeIp, parseProxyEntry, TrustedProxies } from "../src/auth/ip.ts";
import { assertScoped, harness, PASSWORD, signup } from "./helpers.ts";

afterEach(assertScoped);

const LOOPBACK = ["127.0.0.1", "::1"];
const signupBody = (i: number) => ({ email: `p${i}@example.ae`, password: PASSWORD, tenant_id: `t-p-${i}`, dpa_accepted: true });
const peer = (address: string) => ({ requestIP: () => ({ address }) });
const req = (headers: Record<string, string> = {}) => new Request("http://api.test/", { headers });

describe("configuration", () => {
  test("defaults: no trusted proxy, header CF-Connecting-IP", () => {
    const c = loadConfig({});
    expect(c.trustedProxies).toEqual([]);
    expect(c.clientIpHeader).toBe("CF-Connecting-IP");
  });

  test("a list of addresses and CIDRs is read; a malformed entry or header name is refused", () => {
    expect(loadConfig({ CONTROL_TRUSTED_PROXIES: "127.0.0.1, ::1,10.0.0.0/8" }).trustedProxies).toEqual(["127.0.0.1", "::1", "10.0.0.0/8"]);
    expect(loadConfig({ CONTROL_CLIENT_IP_HEADER: "X-Real-IP" }).clientIpHeader).toBe("X-Real-IP");
    for (const bad of ["localhost", "10.0.0.0/33", "::1/129", "1.2.3.4/8/1", "300.1.1.1", "10.0.0.0/x"]) {
      expect(() => loadConfig({ CONTROL_TRUSTED_PROXIES: bad })).toThrow(ConfigError);
    }
    expect(() => loadConfig({ CONTROL_CLIENT_IP_HEADER: "Bad Header" })).toThrow(ConfigError);
  });

  test("entry parsing and loopback detection", () => {
    expect(parseProxyEntry("192.0.2.0/24")).toEqual({ address: "192.0.2.0", prefix: 24, family: 4 });
    expect(parseProxyEntry("::1")).toEqual({ address: "::1", prefix: 128, family: 6 });
    expect(new TrustedProxies(LOOPBACK).loopbackOnly()).toBe(true);
    expect(new TrustedProxies(["127.0.0.0/8"]).loopbackOnly()).toBe(true);
    expect(new TrustedProxies(["127.0.0.1", "10.0.0.1"]).loopbackOnly()).toBe(false);
    expect(new TrustedProxies(["0.0.0.0/0"]).loopbackOnly()).toBe(false);
    expect(new TrustedProxies(["::/0"]).loopbackOnly()).toBe(false);
  });
});

describe("the address rule", () => {
  const proxies = new TrustedProxies(LOOPBACK);
  const H = "CF-Connecting-IP";

  test("no trusted proxy: the server is used unchanged, the header is never read", () => {
    const server = peer("127.0.0.1");
    expect(behindProxies(server, new TrustedProxies([]), H)).toBe(server);
  });

  test("a direct request with a forged header keeps its own address", () => {
    const s = behindProxies(peer("203.0.113.9"), proxies, H);
    expect(s.requestIP?.(req({ [H]: "198.51.100.1" }))?.address).toBe("203.0.113.9");
  });

  test("a request from a trusted peer gets the header's address (IPv4, IPv6, a mapped peer)", () => {
    expect(behindProxies(peer("127.0.0.1"), proxies, H).requestIP?.(req({ [H]: "198.51.100.1" }))?.address).toBe("198.51.100.1");
    expect(behindProxies(peer("::1"), proxies, H).requestIP?.(req({ [H]: "2001:db8::7" }))?.address).toBe("2001:db8::7");
    expect(behindProxies(peer("::ffff:127.0.0.1"), proxies, H).requestIP?.(req({ [H]: "198.51.100.2" }))?.address).toBe("198.51.100.2");
  });

  test("from a trusted peer, a missing, malformed or multi-valued header falls back to the peer address", () => {
    const s = behindProxies(peer("127.0.0.1"), proxies, H);
    expect(s.requestIP?.(req())?.address).toBe("127.0.0.1");
    for (const v of ["", "not-an-ip", "198.51.100.1, 203.0.113.5", "198.51.100.1 203.0.113.5", "198.51.100.1:443", "[2001:db8::1]"]) {
      expect(s.requestIP?.(req({ [H]: v }))?.address).toBe("127.0.0.1");
    }
    const two = new Headers();
    two.append(H, "198.51.100.1");
    two.append(H, "203.0.113.5");
    expect(s.requestIP?.(new Request("http://api.test/", { headers: two }))?.address).toBe("127.0.0.1");
  });

  test("only the configured header is read", () => {
    const s = behindProxies(peer("127.0.0.1"), proxies, "X-Real-IP");
    expect(s.requestIP?.(req({ "CF-Connecting-IP": "198.51.100.1" }))?.address).toBe("127.0.0.1");
    expect(s.requestIP?.(req({ "X-Real-IP": "198.51.100.1" }))?.address).toBe("198.51.100.1");
  });

  test("helpers", () => {
    expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(headerAddress(" 192.0.2.1 ")).toBe("192.0.2.1");
    expect(headerAddress(null)).toBeNull();
  });
});

describe("the per-IP buckets key on the resolved address", () => {
  test("login: behind the tunnel, one attacker exhausting its bucket does not lock out another client", async () => {
    const h = await harness([], { trustedProxies: LOOPBACK });
    const attacker = { ip: "127.0.0.1", headers: { "CF-Connecting-IP": "203.0.113.66" } };
    const spray: number[] = [];
    for (let i = 0; i < 11; i++) spray.push((await h.request("POST", "/v1/account/login", { ...attacker, json: { email: `n${i}@example.test`, password: "wrong password!" } })).status);
    expect(spray.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(spray[10]).toBe(429);
    // Another client through the same tunnel peer has its own bucket.
    const other = await h.request("POST", "/v1/account/login", { ip: "127.0.0.1", headers: { "CF-Connecting-IP": "198.51.100.20" }, json: { email: "x@example.test", password: "wrong password!" } });
    expect(other.status).toBe(401);
  }, 30_000);

  test("login: a forged header from outside the list does not escape the attacker's own bucket", async () => {
    const h = await harness([], { trustedProxies: LOOPBACK });
    const spray: number[] = [];
    for (let i = 0; i < 11; i++) {
      spray.push((await h.request("POST", "/v1/account/login", { ip: "203.0.113.9", headers: { "CF-Connecting-IP": `198.51.100.${i}` }, json: { email: `f${i}@example.test`, password: "wrong password!" } })).status);
    }
    expect(spray[10]).toBe(429);
  }, 30_000);

  test("sign-up: 3 per resolved address per hour; another client behind the same peer still signs up; the session records the client address", async () => {
    const h = await harness([], { trustedProxies: LOOPBACK });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await h.request("POST", "/v1/account/signup", { ip: "127.0.0.1", headers: { "CF-Connecting-IP": "203.0.113.70" }, json: signupBody(i) })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect((await h.request("POST", "/v1/account/signup", { ip: "127.0.0.1", headers: { "CF-Connecting-IP": "198.51.100.71" }, json: signupBody(10) })).status).toBe(202);
  }, 30_000);

  test("sign-up: a forged header on a direct request counts against the socket address", async () => {
    const h = await harness([], { trustedProxies: LOOPBACK });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await h.request("POST", "/v1/account/signup", { ip: "203.0.113.80", headers: { "CF-Connecting-IP": `198.51.100.${i}` }, json: signupBody(20 + i) })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  }, 30_000);

  test("CONTROL_TRUSTED_PROXIES empty: the header is ignored even from loopback (today's behaviour)", async () => {
    const h = await harness();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await h.request("POST", "/v1/account/signup", { ip: "127.0.0.1", headers: { "CF-Connecting-IP": `198.51.100.${i}` }, json: signupBody(30 + i) })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  }, 30_000);

  test("the audit row of a login records the client address the proxy named", async () => {
    const h = await harness([], { trustedProxies: LOOPBACK });
    await signup(h, "a@example.test", "t-a");
    expect((await h.request("POST", "/v1/account/login", { ip: "127.0.0.1", headers: { "CF-Connecting-IP": "198.51.100.90" }, json: { email: "a@example.test", password: PASSWORD } })).status).toBe(200);
    const rows = await h.db.query<{ ip: string | null }>("select ip from audit where action = 'login' order by id desc limit 1");
    expect(rows[0]?.ip).toBe("198.51.100.90");
  }, 30_000);
});
