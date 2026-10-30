// MCP tools for authorization and the App MCP (#294; docs/20-ai-agents-mcp.md
// section 1): why a policy allows or denies (`renox authz explain`), the
// merged policy set, the app's tools from a build, and the dev app's agent
// tokens with a confirmed revoke. Read-only except `revoke_agent_token`,
// which works on the dev tenant file only (`.renox/data/dev/app.db`, what
// `renox dev` runs on) and needs `confirm` to repeat the token id.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { explain } from "../commands/authz.ts";
import { devDb } from "../commands/migrate.ts";
import { buildFiles } from "../lib/build.ts";
import type { AuthzBlock } from "../lib/policies.ts";
import { ToolInputError } from "./tools.ts";

const ACTION = /^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/u;
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/u;
const TYPE = /^[A-Za-z][A-Za-z0-9_]*(:[A-Za-z][A-Za-z0-9_]*)?$/u;

export async function authzExplain(project: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { user, action, resource, roles } = args;
  if (typeof user !== "string" || !ID.test(user)) throw new ToolInputError("user: a user id (letters, digits, _ . : @ -)");
  if (typeof action !== "string" || !ACTION.test(action)) throw new ToolInputError("action: <resource>.<verb>, such as invoice.refund");
  let res: { type: string; id: string } | undefined;
  if (resource !== undefined) {
    const r = resource as { type?: unknown; id?: unknown };
    if (typeof r !== "object" || r === null || typeof r.type !== "string" || !TYPE.test(r.type) || typeof r.id !== "string" || !ID.test(r.id)) throw new ToolInputError("resource: { type, id }");
    res = { type: r.type, id: r.id };
  }
  if (roles !== undefined && (!Array.isArray(roles) || !roles.every((x) => typeof x === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(x)))) throw new ToolInputError("roles: role names");
  const r = await explain(project, { user, action, roles: (roles as string[] | undefined) ?? [], ...(res ? { resource: res } : {}) });
  return { allow: r.allow, reason: r.reason, policies: r.policies, explanation: r.text };
}

/** The policy files, actions, sensitive actions, entities and default roles of the merged set (app and modules). */
export async function listPolicies(project: string): Promise<Record<string, unknown>> {
  const built = await buildFiles(project);
  const owners: { owner: string; authz: AuthzBlock | undefined }[] = [
    { owner: "app", authz: built.manifest.authz as AuthzBlock | undefined },
    ...(built.manifest.modules ?? []).map((m) => ({ owner: (m as { name: string }).name, authz: (m as { authz?: AuthzBlock }).authz })),
  ];
  const files = [...built.files.keys()].filter((p) => p.startsWith("policies/")).sort();
  return {
    files,
    owners: owners
      .filter((o) => o.authz !== undefined)
      .map((o) => ({
        owner: o.owner,
        actions: o.authz?.actions ?? [],
        sensitive: o.authz?.sensitive ?? [],
        entities: Object.fromEntries(Object.entries(o.authz?.entities ?? {}).map(([t, d]) => [t, { table: (d as { table?: string }).table ?? null, attrs: (d as { attrs?: string[] }).attrs ?? [] }])),
        default_roles: o.authz?.default_roles ?? {},
      })),
  };
}

/** The App MCP tools a build of the project carries (artifact 1.3 tool routes). */
export async function listTools(project: string): Promise<Record<string, unknown>> {
  const built = await buildFiles(project);
  const tools = (built.manifest.routes as { kind: string; tool?: Record<string, unknown>; name?: string; description?: string; action?: string; confirm?: boolean; module?: string; input?: unknown }[])
    .filter((r) => r.kind === "tool")
    .map((r) => ({ name: r.name, description: r.description, action: r.action, confirm: r.confirm === true, module: r.module, input: r.input }));
  return { endpoint: "/mcp", tools };
}

function devFile(project: string): string {
  const file = devDb(project);
  if (!existsSync(file)) throw new ToolInputError("no dev database yet: run `renox dev` (or `renox migrate`) first");
  return file;
}

/** The dev app's live agent tokens (auth module, #286): who, which client, which scopes, when. Never a token or its hash. */
export function listAgentTokens(project: string): Record<string, unknown> {
  const db = new Database(devFile(project), { readonly: true });
  try {
    const rows = db
      .query(
        `select a.id, u.email, a.client_name, a.scopes, a.created_at, a.expires_at, a.last_used_at
           from auth__agent_tokens a left join auth__users u on u.id = a.user_id
          where a.revoked_at is null and a.expires_at > ? order by a.created_at desc limit 200`,
      )
      .all(Math.floor(Date.now() / 1000)) as { id: string; email: string | null; client_name: string; scopes: string; created_at: number; expires_at: number; last_used_at: number | null }[];
    return { tokens: rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] })) };
  } catch (e) {
    if (/no such table/u.test(String(e))) return { tokens: [], note: "the auth module is not installed, or its agent tables are not migrated" };
    throw e;
  } finally {
    db.close();
  }
}

/**
 * Revokes one of the dev app's agent tokens: `confirm` must repeat `id`.
 * The dev worker's /mcp keeps a verified token for up to 60 s (#285); the
 * account page's revoke (which emits auth.agent_token_revoked) drops it at once.
 */
export function revokeAgentToken(project: string, args: Record<string, unknown>): Record<string, unknown> {
  const { id, confirm } = args;
  if (typeof id !== "string" || !/^agt_[0-9a-f]{24}$/u.test(id)) throw new ToolInputError("id: an agent token id (agt_…), from list_agent_tokens");
  if (confirm !== id) throw new ToolInputError("confirm: repeat the token id to revoke it");
  const db = new Database(devFile(project));
  try {
    db.exec("pragma busy_timeout = 5000");
    const r = db.query("update auth__agent_tokens set revoked_at = ? where id = ? and revoked_at is null").run(Math.floor(Date.now() / 1000), id);
    return { revoked: r.changes === 1, id };
  } finally {
    db.close();
  }
}
