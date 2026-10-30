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
  listClientErrors: "logs:read",
  getClientError: "logs:read",
  setClientErrorStatus: "apps:write",
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
  // Usage (src/ingest/routes.ts, #56).
  getUsage: "apps:read",
  // Backups (src/tenants/backups.ts, deploy-api.md 0.3 section 14; #257, #258).
  getBackups: "apps:read",
  exportBackup: "apps:write",
  restoreBackup: "apps:write",
  importDatabase: "apps:write",
  // The signed download of an export from a store that cannot presign; the
  // signature is the credential (src/tenants/backups.ts).
  downloadExport: "public",
  // Operator actions (src/ops/tenants.ts, section 17; #259).
  setTenantTier: "operator",
  moveTenant: "operator",
  // deploy-api.md 0.3.1 section 17: the read of operator data (ops:read), implemented by #296.
  getOpsTenant: "operator",
  // deploy-api.md 0.4 (#303): the node read, break-glass (#310, #311) and tenant erasure (#308).
  getNode: "operator",
  impersonateTenant: "operator",
  endImpersonation: "operator",
  getTenant: "apps:read",
  // security.txt on the API host (src/well-known.ts, #310).
  getSecurityTxt: "public",
  deleteTenant: "tenant:delete",
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
  // Second factors (src/auth/mfa.ts, #293), in the contract from deploy-api.md 0.4 section 18.
  getMfa: "account",
  startTotp: "account",
  confirmTotp: "account",
  passkeyOptions: "account",
  registerPasskey: "account",
  mfaChallenge: "account",
  verifyMfa: "account",
  regenerateRecoveryCodes: "account",
  disableMfa: "account",
  setTeamMfaRequired: "team:write",
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
  // Remote platform MCP and its OAuth server (src/mcp, #62). They authenticate
  // themselves (an MCP access token; the session cookie on the consent page),
  // not through the tenant middleware, so the table lists them as public. Each
  // tool runs as an internal request to one of the operations above, with the
  // agent's token, and is governed by that operation's row.
  getProtectedResourceMetadata: "public",
  getAuthorizationServerMetadata: "public",
  registerOAuthClient: "public",
  showOAuthConsent: "public",
  decideOAuthConsent: "public",
  exchangeOAuthCode: "public",
  callMcp: "public",
  mcpMethodNotAllowed: "public",
};
