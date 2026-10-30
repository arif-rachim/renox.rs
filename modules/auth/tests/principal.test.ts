// The principal auth gives the platform (#291; ops.md 1.5.0 section 17):
// `{ id, attrs }` of the signed-in user with email_verified,
// phone_verified and created_at, extended by `auth.principal` fillers (the
// otpbox fixture sets org; a key outside the schema is dropped), the
// role assignments added by the cell, anonymous when signed out, and the
// cache dropped at logout.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("principal", () => {
  test("shape, filler attrs, roles, anonymous, logout", async () => {
    expect((await t.as("nobody").request("GET", "/api/principal")).json()).toBeNull();
    const pia = t.as("pia");
    await pia.action("/auth/register", "default", { email: "pia@example.com", password: "correct horse battery", display_name: "Pia" });
    expect((await pia.action("/auth/login", "default", { email: "pia@example.com", password: "correct horse battery" })).status).toBe(303);
    const id = t.db.query<{ id: string }>("select id from auth__users where email = 'pia@example.com'")[0]?.id as string;
    const p = (await pia.request("GET", "/api/principal")).json<{ id: string; kind: string; roles: unknown[]; attrs: Record<string, unknown> }>();
    expect(p.id).toBe(id);
    expect(p.attrs).toEqual({ email_verified: false, phone_verified: false, created_at: expect.any(Number), org: "o_test" });
    expect(p.roles).toEqual([]);
    // A role assignment invalidates the cache (authz.roles_changed): the next request has the role.
    expect((await pia.request("POST", "/api/principal")).status).toBe(200);
    type Role = { role: string; scope_type: string; scope_id: string | null };
    let roles: Role[] = [];
    for (let i = 0; i < 40 && !roles.some((r) => r.role === "editor"); i++) {
      roles = (await pia.request("GET", "/api/principal")).json<{ roles: Role[] }>().roles;
      if (!roles.some((r) => r.role === "editor")) await Bun.sleep(50);
    }
    expect(roles).toEqual([{ role: "editor", scope_type: "global", scope_id: null }]);
    // Logout: the next request is anonymous.
    expect((await pia.action("/auth/account", "logout", {})).status).toBe(303);
    expect((await pia.request("GET", "/api/principal")).json()).toBeNull();
  });
});
