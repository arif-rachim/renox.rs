// The scopes of the dashboard's own token after a password sign-in (#445):
// what each role holds of DASHBOARD_SCOPES, exactly as the API's role matrix
// says, and never `tokens:write` or `registry:publish`
// (docs/24-threat-model.md E, "Leaked CLI or CI token").
import { expect, test } from "bun:test";

import { ACTIONS } from "../../api/src/auth/tokens.ts";
import { MATRIX, ROLES } from "../../api/src/tenancy/roles.ts";
import { DASHBOARD_SCOPES, DASHBOARD_TOKEN_DAYS, GRANTABLE_SCOPES, ROLE_SCOPES } from "../lib/scopes.ts";

test("each role gets the dashboard scopes the API's matrix gives it, no more", () => {
  for (const role of ROLES) {
    expect([role, [...ROLE_SCOPES[role]].sort()]).toEqual([role, DASHBOARD_SCOPES.filter((s) => MATRIX[s].includes(role)).sort()]);
  }
});

test("the dashboard's token can never mint tokens or publish modules, and lives one day", () => {
  expect(DASHBOARD_SCOPES as readonly string[]).not.toContain("tokens:write");
  expect(DASHBOARD_SCOPES as readonly string[]).not.toContain("registry:publish");
  expect(DASHBOARD_TOKEN_DAYS).toBe(1);
});

test("the Tokens and device pages offer exactly the API's token scopes", () => {
  expect([...GRANTABLE_SCOPES].sort()).toEqual([...ACTIONS].sort());
});

test("the CSP lets the browser reach the production API (renox.toml connect_src)", async () => {
  const toml = Bun.TOML.parse(await Bun.file(new URL("../renox.toml", import.meta.url)).text()) as { security: { csp: { connect_src: string[] } } };
  expect(toml.security.csp.connect_src).toContain("https://api.renoxium.com");
});
