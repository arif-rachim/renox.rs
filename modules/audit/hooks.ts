// The audit module's listeners (#288): events of auth, org, and the
// platform become rows of audit__events. Events need no dependency: a
// listener for a module that is not installed never runs. The payloads
// are redacted like any other details (`auth.agent_token_revoked` carries
// a token hash, which is stored as "[redacted]").

import { record, type AuditInput } from "./services.ts";

interface Event {
  name: string;
  payload: Record<string, unknown>;
}

type Ctx = Parameters<typeof record>[0];

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The row of one event: who did it, to what. */
function rowOf(e: Event): AuditInput | null {
  const p = e.payload ?? {};
  const user = str(p.user_id);
  switch (e.name) {
    case "auth.login":
    case "auth.password_changed":
      return user ? { action: e.name, actor: { kind: "user", id: user }, resource: { type: "auth:User", id: user }, details: p } : null;
    case "auth.agent_token_revoked":
      return user ? { action: e.name, actor: { kind: "user", id: user }, resource: { type: "auth:AgentToken" }, details: p } : null;
    case "authz.roles_changed":
      // The granting principal is not in the payload: the platform wrote
      // `granted_by` in renox__role_assignments, and the trail shows the
      // change itself.
      return user ? { action: e.name, actor: { kind: "system", id: "system:authz" }, resource: { type: "Renox:Role", id: str(p.role) }, details: p } : null;
    case "org.created":
    case "org.member_added":
      return user ? { action: e.name, actor: { kind: "user", id: user }, resource: { type: "org:Org", id: str(p.org_id) }, details: p } : null;
    case "org.member_removed": {
      const by = str(p.by) ?? user;
      return by ? { action: e.name, actor: { kind: "user", id: by }, resource: { type: "org:Org", id: str(p.org_id) }, details: p } : null;
    }
    default:
      return null;
  }
}

const listen = async (ctx: Ctx, e: Event): Promise<void> => {
  const row = rowOf(e);
  if (row !== null) await record(ctx, row, e.name);
};

export const on = {
  "auth.login": listen,
  "auth.password_changed": listen,
  "auth.agent_token_revoked": listen,
  "authz.roles_changed": listen,
  "org.created": listen,
  "org.member_added": listen,
  "org.member_removed": listen,
};
