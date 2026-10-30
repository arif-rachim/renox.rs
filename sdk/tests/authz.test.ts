// #283: the authorization helpers of the SDK (docs/contracts/ops.md
// section 17): `defineGuard` checks the guard's shape, `resource` builds a
// `ResourceRef` from a row, `isForbidden` recognises the deny of
// `authz.require`, `userScope` the scope of the request's own user.

import { describe, expect, expectTypeOf, test } from "bun:test";

import { defineGuard, ForbiddenError, type Guard, isForbidden, RenoxError, resource, type ResourceRef, userScope } from "../src/index.ts";

describe("defineGuard", () => {
  test("returns the guard unchanged and keeps its literal type", () => {
    const g = defineGuard({ action: "invoice.read", resource: { type: "Invoice", id: ":id" } });
    expect(g).toEqual({ action: "invoice.read", resource: { type: "Invoice", id: ":id" } });
    expectTypeOf(g).toMatchTypeOf<Guard>();
    expectTypeOf(g.action).toEqualTypeOf<"invoice.read">();
  });

  test("refuses an action that is not <resource>.<verb>, and a resource without an id", () => {
    expect(() => defineGuard({ action: "invoice" as `${string}.${string}` })).toThrow(TypeError);
    expect(() => defineGuard({ action: "Invoice.Read" as `${string}.${string}` })).toThrow(/<resource>.<verb>/u);
    expect(() => defineGuard({ action: "invoice.read", resource: { type: "Invoice", id: "" } })).toThrow(/resource is/u);
  });
});

test("resource() types a row and stringifies its id", () => {
  const r = resource("Invoice", { id: 42, org: "o_1", total: 10 });
  expect(r).toEqual({ id: "42", org: "o_1", total: 10, type: "Invoice" });
  expectTypeOf(r).toMatchTypeOf<ResourceRef>();
});

test("isForbidden recognises ForbiddenError and a RENOX_FORBIDDEN RenoxError", () => {
  const f = new ForbiddenError("no", { action: "invoice.refund", resource: null, reason: "deny", policy: null });
  expect(isForbidden(f)).toBe(true);
  expect(isForbidden(new RenoxError("RENOX_FORBIDDEN", "no", undefined))).toBe(true);
  expect(isForbidden(new RenoxError("RENOX_DB_SCOPE", "no", undefined))).toBe(false);
  expect(isForbidden(new Error("RENOX_FORBIDDEN"))).toBe(false);
});

test("userScope is the request user's scope and refuses the anonymous and system principals", () => {
  expect(userScope({ id: "u_1", kind: "user" }, { org_id: "o_1" })).toEqual({ org_id: "o_1", user_id: "u_1" });
  expect(() => userScope(null)).toThrow(ForbiddenError);
  expect(() => userScope({ id: "app", kind: "system" })).toThrow(ForbiddenError);
});
