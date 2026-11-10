// #679: a `[security].csp.*` source never holds `;` or `,` (manifest.md MF17, artifact.md V16): `;` ends a
// directive and `,` starts a second policy in the header. `renox check` refuses it with the MF17 message.

import { expect, test } from "bun:test";

import { checkSecurity, securityProblems } from "../src/check/security.ts";

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
