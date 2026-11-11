// The scopes of the token a password sign-in creates for the dashboard
// (#445). After the browser has signed in against the API (ADR D23), it
// creates a short-lived tenant token named `dashboard` with the scopes below
// that the user's role holds, and hands it to /signin, which stores it like a
// pasted token (lib/session.ts).
//
// Never `tokens:write` (a stolen dashboard sign-in must not mint more
// tokens; the Tokens and device pages use the browser's API session, where
// the step-up rule applies) and never `registry:publish`.
// tests/scopes.test.ts checks ROLE_SCOPES against the API's role matrix.

// `apps:delete` (deploy-api.md 0.7, #536): the settings page's "Delete this
// app", for owners and admins; a deleted app is restorable for 7 days. The
// same scope renames an app (#537, "Rename this app").
export const DASHBOARD_SCOPES = ["apps:read", "apps:write", "deploy", "logs:read", "secrets:read", "secrets:write", "domains:write", "registry:read", "apps:delete"] as const;
export type DashboardScope = (typeof DASHBOARD_SCOPES)[number];

/** control/api/src/tenancy/roles.ts `MATRIX`, restricted to DASHBOARD_SCOPES. */
export const ROLE_SCOPES: Readonly<Record<"owner" | "admin" | "developer" | "viewer", readonly DashboardScope[]>> = {
  owner: DASHBOARD_SCOPES,
  admin: DASHBOARD_SCOPES,
  developer: ["apps:read", "apps:write", "deploy", "logs:read", "secrets:read", "registry:read"],
  viewer: ["apps:read", "logs:read", "secrets:read", "registry:read"],
};

/** Every scope a person can grant a token or a device on the Tokens and device pages (deploy-api.yaml `Scope` actions). */
export const GRANTABLE_SCOPES = ["apps:read", "apps:write", "deploy", "logs:read", "secrets:read", "secrets:write", "domains:write", "tokens:write", "registry:read", "registry:publish", "apps:delete", "app:settings", "app:people"] as const;

/** The lifetime of the dashboard's own token, in days: the API's smallest unit. */
export const DASHBOARD_TOKEN_DAYS = 1;

/** control/api/src/tenancy/roles.ts `MATRIX` for the token scopes: what each role may grant a token or a device (#446). */
export const ROLE_GRANTABLE: Readonly<Record<"owner" | "admin" | "developer" | "viewer", readonly (typeof GRANTABLE_SCOPES)[number][]>> = {
  owner: GRANTABLE_SCOPES,
  admin: GRANTABLE_SCOPES,
  developer: ["apps:read", "apps:write", "deploy", "logs:read", "secrets:read", "tokens:write", "registry:read"],
  viewer: ["apps:read", "logs:read", "secrets:read", "registry:read"],
};
