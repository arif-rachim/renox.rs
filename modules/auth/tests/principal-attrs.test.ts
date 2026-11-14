// The attributes auth keeps of the principal (#791; ops.md 1.23.0 section
// 17): `has_password` is a platform attribute; the app's own boolean
// attributes (`[authz] user_attrs`) are kept when the app's filler sets them
// and never when a module's does; anything else is dropped. The library
// level: a filler is a function that runs with `ctx.caller` set, as the
// runtime does for a hook filler.

import { describe, expect, test } from "bun:test";

import { keptAttrs, MAX_APP_ATTRS, PRINCIPAL_ATTRS, principalForFillers } from "../lib/agents.ts";

type Attrs = Record<string, unknown>;

/** Runs `filler` as module `caller` (undefined: the app) over a principal with `attrs`; returns what auth keeps. */
function run(caller: string | undefined, attrs: Attrs, filler: (a: Attrs, p: { attrs: Attrs }) => void): Attrs {
  const ctx: { caller?: unknown } = {};
  const f = principalForFillers(ctx, { id: "u_1", attrs });
  ctx.caller = caller;
  filler(f.principal.attrs, f.principal);
  ctx.caller = undefined;
  return keptAttrs(f.read().attrs);
}

describe("principal attributes", () => {
  test("has_password is one of the platform's attributes", () => {
    expect(PRINCIPAL_ATTRS).toContain("has_password");
    expect(keptAttrs({ has_password: true, email_verified: false })).toEqual({ has_password: true, email_verified: false });
  });

  test("the app's filler sets a boolean app attribute", () => {
    expect(run(undefined, { email_verified: true }, (a) => (a.portal = true))).toEqual({ email_verified: true, portal: true });
    expect(run(undefined, {}, (a) => Object.assign(a, { portal: false }))).toEqual({ portal: false });
  });

  test("a module filler cannot set, change or delete an app attribute", () => {
    expect(run("evil", {}, (a) => (a.portal = true))).toEqual({});
    expect(run("evil", {}, (a) => Object.assign(a, { portal: true }))).toEqual({});
    expect(run("evil", { portal: true }, (a) => (a.portal = false))).toEqual({ portal: true });
    expect(run("evil", { portal: true }, (a) => void delete a.portal)).toEqual({ portal: true });
    // Replacing attrs does not get around it, and the platform keys carry over.
    expect(run("evil", { portal: true }, (_a, p) => (p.attrs = { portal: false, other: true, org: "o_1" }))).toEqual({ portal: true, org: "o_1" });
  });

  test("a module filler still sets the platform's attributes (org, mfa_verified)", () => {
    expect(run("2fa", {}, (a) => (a.mfa_verified = true))).toEqual({ mfa_verified: true });
    expect(run("org", {}, (a) => (a.org = "o_1"))).toEqual({ org: "o_1" });
  });

  test("a non-boolean value, a bad name and a ninth attribute are dropped", () => {
    expect(run(undefined, {}, (a) => Object.assign(a, { portal: "true", count: 1, nested: { x: true }, Bad: true, x: true, "a-b": true, undef: undefined }))).toEqual({});
    const many: Attrs = {};
    for (let i = 0; i < MAX_APP_ATTRS + 2; i++) many[`flag_${i}`] = true;
    expect(Object.keys(run(undefined, {}, (a) => Object.assign(a, many)))).toHaveLength(MAX_APP_ATTRS);
  });
});
