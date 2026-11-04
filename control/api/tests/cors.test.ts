// Browser calls from the dashboard (#445, ADR D23; docs/24-threat-model.md E,
// "Cross-site request to the API"): CORS for the dashboard origin only, on the
// account and token paths only, with credentials.

import { afterEach, describe, expect, test } from "bun:test";

import { corsPath } from "../src/cors.ts";
import { assertScoped, harness, PASSWORD, signup } from "./helpers.ts";

afterEach(assertScoped);

/** `dashboardUrl` of the test harness (tests/helpers.ts). */
const DASHBOARD = "https://dashboard.renox.test";

describe("CORS for the dashboard", () => {
  test("a preflight from the dashboard origin on /v1/account/login allows credentials, the CSRF header and the three methods", async () => {
    const h = await harness();
    const res = await h.request("OPTIONS", "/v1/account/login", { headers: { origin: DASHBOARD, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type, x-renox-csrf");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE");
  });

  test("another origin gets no CORS headers, on the preflight and on the request", async () => {
    const h = await harness();
    for (const origin of ["https://evil.example", "https://dashboard.renox.test.evil.example", "http://dashboard.renox.test", "https://dashboard.renoxium.com", "null"]) {
      const pre = await h.request("OPTIONS", "/v1/account/login", { headers: { origin, "access-control-request-method": "POST" } });
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
      const res = await h.request("POST", "/v1/account/login", { headers: { origin }, json: { email: "x@example.test", password: PASSWORD } });
      expect(res.status).toBe(401);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  test("the dashboard origin gets no CORS headers outside /v1/account and /v1/tokens", async () => {
    const h = await harness();
    for (const path of ["/v1/apps", "/v1/nodes/n1/routes", "/v1/healthz", "/v1/accountx"]) {
      const pre = await h.request("OPTIONS", path, { headers: { origin: DASHBOARD, "access-control-request-method": "GET" } });
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(corsPath("/v1/account/mfa/verify")).toBe(true);
    expect(corsPath("/v1/tokens/tok_1")).toBe(true);
    expect(corsPath("/v1/apps/x")).toBe(false);
  });

  test("a sign-in from the dashboard origin: the answer carries the origin, credentials and the exposed headers, errors included", async () => {
    const h = await harness();
    await signup(h, "c@example.test", "t-cors");
    const ok = await h.request("POST", "/v1/account/login", { headers: { origin: DASHBOARD }, json: { email: "c@example.test", password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(ok.headers.get("access-control-expose-headers")).toBe("retry-after, x-renox-request-id");
    const bad = await h.request("POST", "/v1/account/login", { headers: { origin: DASHBOARD }, json: { email: "c@example.test", password: "wrong password!" } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });

  test("the allowed origin follows CONTROL_DASHBOARD_URL", async () => {
    const h = await harness();
    (h.deps.config as { dashboardUrl: string }).dashboardUrl = "http://localhost:8790/";
    const res = await h.request("OPTIONS", "/v1/tokens", { headers: { origin: "http://localhost:8790", "access-control-request-method": "POST" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8790");
    const old = await h.request("OPTIONS", "/v1/tokens", { headers: { origin: DASHBOARD, "access-control-request-method": "POST" } });
    expect(old.headers.get("access-control-allow-origin")).toBeNull();
  });
});
