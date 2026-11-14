// #769: lib/admin.ts sensitive() follows twofa's cause_details.verify_url only when it is a path on this site.
import { describe, expect, test } from "bun:test";

import { stepUpUrl } from "../lib/step-up";

describe("the step-up's verify_url (#769)", () => {
  test("normal case: twofa's verify_url, a path on this site, is used as it is", () => {
    expect(stepUpUrl("/2fa/verify?next=%2Fadmin%2Fpeople", "/admin/people")).toBe("/2fa/verify?next=%2Fadmin%2Fpeople");
  });

  test("edge case: no verify_url, or not a string, builds twofa's verification page from next", () => {
    expect(stepUpUrl(undefined, "/admin/people")).toBe("/2fa/verify?next=%2Fadmin%2Fpeople");
    expect(stepUpUrl(42, "/services")).toBe("/2fa/verify?next=%2Fservices");
  });

  test("error case: another origin, a protocol-relative or backslash path, or a value with spaces is never followed", () => {
    for (const bad of ["https://evil.example/verify", "//evil.example/verify", "/\\evil.example", "javascript:alert(1)", "2fa/verify", "/2fa/verify next", ""]) {
      expect(stepUpUrl(bad, "/admin")).toBe("/2fa/verify?next=%2Fadmin");
    }
  });
});
