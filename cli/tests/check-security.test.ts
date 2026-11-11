// #679: a `[security].csp.*` source never holds `;` or `,` (manifest.md MF17, artifact.md V16): `;` ends a
// directive and `,` starts a second policy in the header. `renox check` refuses it with the MF17 message.

import { expect, test } from "bun:test";

import { checkSecurity, cspValue, securityProblems } from "../src/check/security.ts";

test("a ';' or ',' in an app CSP source is refused with the MF17 message", () => {
  for (const src of ["https://cdn.example/;report-uri", "https://cdn.example/a,b"]) {
    const problems = securityProblems({ csp: { script_src: [src] } }, []);
    expect(problems).toEqual([`MF17: security.csp.script_src "${src}" is not an https:// origin (optional *. wildcard and path), data: or blob:`]);
  }
  expect(() => checkSecurity({ csp: { img_src: ["https://i.example/x;y"] } }, [])).toThrow(/MF17: security\.csp\.img_src/u);
});

test("ordinary sources are still accepted", () => {
  const csp = { script_src: ["https://js.stripe.com", "https://*.tabby.ai/v1/a-b_c"], img_src: ["data:", "blob:"] };
  expect(securityProblems({ csp }, [])).toEqual([]);
});

test("#740: form_action is an https origin; a wildcard, http, data: or ';' source is refused", () => {
  expect(securityProblems({ csp: { form_action: ["https://api.example.com", "https://pay.example.com:8443"] } }, [])).toEqual([]);
  for (const src of ["https://*.example.com", "http://api.example.com", "data:", "blob:", "https://api.example.com/path"])
    expect(securityProblems({ csp: { form_action: [src] } }, []).length).toBeGreaterThan(0);
  expect(securityProblems({ csp: { form_action: ["https://a.example/;script-src *"] } }, [])).toEqual([
    'MF17: security.csp.form_action "https://a.example/;script-src *" is not an https:// origin (no wildcard host, no path)',
  ]);
  expect(securityProblems({ csp: { form_action: Array.from({ length: 9 }, (_, i) => `https://f${i}.example.com`) } }, []).length).toBeGreaterThan(0);
});

test("#740: cspValue puts form_action after 'self'; without it the header is unchanged", () => {
  expect(cspValue({}, "n", false)).toContain("base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  expect(cspValue({ csp: { form_action: ["https://api.example.com"] } }, "n", false)).toContain("form-action 'self' https://api.example.com; frame-ancestors 'none'");
});
