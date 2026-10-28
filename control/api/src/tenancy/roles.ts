// Roles per tenant and the permission matrix (#113; docs/24-threat-model.md
// E, "Teammate with too much power"). The table below is the source of truth;
// control/api/README.md, "Roles", prints the same matrix and a test checks
// that both agree.
//
// Permissions are the token scopes of docs/contracts/deploy-api.md section 2
// (the `x-renox-scope` of each operation) plus five that only a signed-in user
// holds: a token never manages the team, billing, or deletes.

import { ACTIONS, type Action } from "../auth/tokens.ts";

export const ROLES = ["owner", "admin", "developer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const SESSION_PERMISSIONS = ["team:read", "team:write", "billing", "apps:delete", "tenant:delete"] as const;
export type SessionPermission = (typeof SESSION_PERMISSIONS)[number];
export type Permission = Action | SessionPermission;

export const PERMISSIONS: readonly Permission[] = [...ACTIONS, ...SESSION_PERMISSIONS];

/** Which roles hold each permission. */
export const MATRIX: Record<Permission, readonly Role[]> = {
  "apps:read": ["owner", "admin", "developer", "viewer"],
  "apps:write": ["owner", "admin", "developer"],
  deploy: ["owner", "admin", "developer"],
  "logs:read": ["owner", "admin", "developer", "viewer"],
  "secrets:read": ["owner", "admin", "developer", "viewer"],
  "secrets:write": ["owner", "admin"],
  "domains:write": ["owner", "admin"],
  "tokens:write": ["owner", "admin", "developer"],
  "team:read": ["owner", "admin", "developer", "viewer"],
  "team:write": ["owner", "admin"],
  billing: ["owner"],
  "apps:delete": ["owner", "admin"],
  "tenant:delete": ["owner"],
};

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export const roleAllows = (role: Role, permission: Permission): boolean => MATRIX[permission].includes(role);

export const isTokenPermission = (p: Permission): p is Action => (ACTIONS as readonly string[]).includes(p);

/** Roles that may see and revoke every token of the tenant, not only their own. */
export const seesAllTokens = (role: Role): boolean => role === "owner" || role === "admin";

/**
 * Who may call each operation (by operationId). A permission means a tenant
 * principal (token or session) holding it; `account` a signed-in user, no
 * tenant permission; `public` no credentials (rate limited); `node` and
 * `operator` the deploy API's other callers. The tenant middleware refuses a
 * route whose permission differs from this table, and a test checks the table
 * against `x-renox-scope` in docs/contracts/schemas/deploy-api.yaml.
 */
export const ROUTE_PERMISSIONS: Record<string, Permission | "account" | "public" | "node" | "operator"> = {
  getHealth: "public",
  createApp: "apps:write",
  listApps: "apps:read",
  getApp: "apps:read",
  uploadDeployment: "deploy",
  listDeployments: "apps:read",
  getDeployment: "apps:read",
  putSourcemaps: "deploy",
  activateDeployment: "deploy",
  rollbackDeployment: "deploy",
  streamLogs: "logs:read",
  listSecrets: "secrets:read",
  putSecret: "secrets:write",
  deleteSecret: "secrets:write",
  bumpSecrets: "secrets:write",
  addDomain: "domains:write",
  listDomains: "apps:read",
  getDomain: "apps:read",
  removeDomain: "domains:write",
  createToken: "tokens:write",
  listTokens: "tokens:write",
  revokeToken: "tokens:write",
  createTenant: "operator",
  suspendTenant: "operator",
  reinstateTenant: "operator",
  createNodeToken: "operator",
  registerNode: "node",
  heartbeat: "node",
  nodeStream: "node",
  routeSnapshot: "node",
  prepareResult: "node",
  fetchArtifact: "node",
  fetchSecrets: "node",
  fetchCertificate: "node",
  ingestMeters: "node",
  ingestLogs: "node",
  // Accounts (src/auth/accounts.ts).
  signup: "public",
  verifyEmail: "public",
  resendVerification: "account",
  login: "public",
  logout: "account",
  requestPasswordReset: "public",
  confirmPasswordReset: "public",
  getAccount: "account",
  switchTenant: "account",
  listSessions: "account",
  revokeSession: "account",
  revokeAllSessions: "account",
  startDeviceLogin: "public",
  pollDeviceLogin: "public",
  approveDeviceLogin: "tokens:write",
  acceptInvitation: "account",
  // Team (src/tenancy/team.ts).
  listMembers: "team:read",
  inviteMember: "team:write",
  listInvitations: "team:read",
  revokeInvitation: "team:write",
  changeMemberRole: "team:write",
  removeMember: "team:write",
  proposeOwnerTransfer: "team:write",
  acceptOwnerTransfer: "team:read",
  cancelOwnerTransfer: "team:write",
};
