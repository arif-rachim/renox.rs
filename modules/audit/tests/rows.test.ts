// The rows the listeners write, without a worker (hooks.ts rowOf).
import { expect, test } from "bun:test";

import { rowOf } from "../hooks.ts";

test("twofa.reset: the administrator is the actor, the user whose second factor was reset is the resource (#735)", () => {
  const row = rowOf({ name: "twofa.reset", payload: { user_id: "u_tech", by: "u_owner" } });
  expect(row).toEqual({ action: "twofa.reset", actor: { kind: "user", id: "u_owner" }, resource: { type: "twofa:User", id: "u_tech" }, details: { user_id: "u_tech", by: "u_owner" } });
});

test("twofa.reset without `by` or `user_id` writes no row", () => {
  expect(rowOf({ name: "twofa.reset", payload: { user_id: "u_tech" } })).toBeNull();
  expect(rowOf({ name: "twofa.reset", payload: { by: "u_owner" } })).toBeNull();
});
