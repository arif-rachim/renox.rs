// `[security]` and `renox check --security` (#47). The default CSP string is
// the one crates/renox-gateway/src/security/headers.rs asserts.
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cspValue, headerSet, securityProblems, securityReport } from "../src/check/security.ts";
import { check, securityOutput } from "../src/commands/check.ts";
import { buildFiles } from "../src/lib/build.ts";
import type { Route } from "../src/lib/routes.ts";

const routes: Route[] = [
  { kind: "function", method: "POST", path: "/api/login", module: "functions/api/login", export: "POST" },
  { kind: "page", path: "/products/:id", module: "pages/products/[id]", load: true, actions: ["addToCart"], template: "pages/products/[id]" },
];

test("default headers match the gateway's table", () => {
  expect(cspValue({}, "N0nce", false)).toBe(
    "default-src 'self'; script-src 'self' 'nonce-N0nce'; style-src 'self' 'nonce-N0nce'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; report-uri /__renox/events?kind=csp; report-to renox-csp",
  );
  expect(headerSet({}, "n", false)[1]).toEqual(["Reporting-Endpoints", `renox-csp="/__renox/events?kind=csp"`]);
  expect(headerSet({}, "n", false).slice(3)).toEqual([
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
  ]);
  const s = { csp: { script_src: ["https://js.stripe.com"], img_src: ["data:"] }, headers: { permissions_allow: ["camera", "payment"] } };
  expect(cspValue(s, "n", true)).toContain("script-src 'self' 'nonce-n' https://js.stripe.com; style-src 'self' 'nonce-n'; img-src 'self' data:;");
  expect(cspValue(s, "n", true)).toContain("frame-ancestors 'none'; upgrade-insecure-requests; report-uri");
  expect(headerSet(s)[6]).toEqual(["Permissions-Policy", "microphone=(), geolocation=(), camera=(self), payment=(self)"]);
});

test("V16 and the schema: unsafe-inline needs allow_unsafe, credentials need origins, buckets name routes", () => {
  expect(securityProblems({ csp: { script_src: ["'unsafe-inline'"] } }, routes)).toEqual([
    "V16: security.csp.script_src has 'unsafe-inline'; set [security.csp] allow_unsafe = true to opt in (flagged in the dashboard)",
  ]);
  expect(securityProblems({ csp: { script_src: ["'unsafe-inline'"], allow_unsafe: true } }, routes)).toEqual([]);
  expect(securityProblems({ cors: { credentials: true } }, routes)).toEqual(["V16: security.cors.credentials needs a non-empty security.cors.origins"]);
  expect(securityProblems({ ratelimit: [{ method: "POST", path: "/api/logout", requests: 5, window_s: 60, key: "ip" }] }, routes)).toEqual([
    "V16: security.ratelimit POST /api/logout: no route answers it",
  ]);
  expect(securityProblems({ ratelimit: [{ method: "POST", path: "/products/:id", requests: 5, window_s: 60, key: "ip" }] }, routes)).toEqual([]);
  expect(securityProblems({ cors: { origins: ["*"] } }, routes).join("\n")).toContain("security.cors.origins");
  expect(securityProblems({ csp: { script_src: ["http://insecure.example"] } }, routes).length).toBeGreaterThan(0);
});

test("renox check --security output", () => {
  const out = securityReport(
    {
      csp: { script_src: ["https://js.stripe.com"] },
      cors: { origins: ["https://partner.example"], credentials: true },
      ratelimit: [{ method: "POST", path: "/api/login", requests: 5, window_s: 60, key: "ip" }],
    },
    routes,
  );
  expect(out).toBe(`Response headers (every route; the nonce is fresh per request):
  Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<per-request>' https://js.stripe.com; style-src 'self' 'nonce-<per-request>'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri /__renox/events?kind=csp; report-to renox-csp
  Reporting-Endpoints: renox-csp="/__renox/events?kind=csp"
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
CORS: https://partner.example; methods GET, HEAD, POST; headers none; credentials yes; max-age 600 s
Routes:
  POST           /api/login  function, rate limit POST 5/60 s per ip
  GET,HEAD,POST  /products/:id  page, CSRF-checked actions
`);
});

test("[security] in renox.toml reaches manifest.security; unsafe-inline without opt-in fails renox check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renox-sec-"));
  cpSync(join(import.meta.dir, "fixtures/routes"), dir, { recursive: true });
  const toml = `[app]\nname = "x"\ntimezone = "UTC"\n\n[security.csp]\nscript_src = ["https://js.stripe.com"]\n\n[security.cors]\norigins = ["https://partner.example"]\n\n[[security.ratelimit]]\nmethod = "GET"\npath = "/api/notes"\nrequests = 10\nwindow_s = 60\nkey = "ip"\n`;
  writeFileSync(join(dir, "renox.toml"), toml);
  const { manifest } = await buildFiles(dir);
  expect(manifest.security).toEqual({
    csp: { script_src: ["https://js.stripe.com"] },
    cors: { origins: ["https://partner.example"] },
    ratelimit: [{ method: "GET", path: "/api/notes", requests: 10, window_s: 60, key: "ip" }],
  });
  expect(securityOutput(dir)).toContain("/api/notes  function, rate limit GET 10/60 s per ip");
  writeFileSync(join(dir, "renox.toml"), `[app]\nname = "x"\ntimezone = "UTC"\n\n[security.csp]\nscript_src = ["'unsafe-inline'"]\n`);
  const r = await check(dir);
  expect(r.errors.map((e) => e.message).join("\n")).toContain("allow_unsafe");
  writeFileSync(join(dir, "renox.toml"), `[app]\nname = "x"\ntimezone = "UTC"\n\n[security.cps]\nscript_src = []\n`);
  expect((await check(dir)).errors.map((e) => e.message).join("\n")).toContain('unknown key "cps" in [security]');
});
