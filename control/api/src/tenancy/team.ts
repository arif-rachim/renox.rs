// The tenant's team (#113; docs/24-threat-model.md E, "Teammate with too much
// power"): members and their roles, invitations, removal, and the owner
// transfer, which needs both the owner and the new owner. Only signed-in
// users manage a team; the permissions are session-only (src/tenancy/roles.ts).

import type { Context, Hono } from "hono";
import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import { emailField } from "../auth/accounts.ts";
import { sendInvitation, sendOwnerTransfer } from "../auth/notify.ts";
import { newOneTimeValue } from "../auth/sessions.ts";
import { sha256hex } from "../auth/tokens.ts";
import type { Deps, Env, Principal } from "../context.ts";
import { num } from "../db/db.ts";
import { ApiError, conflict, invalid, notFound } from "../errors.ts";
import { JSON_LIMIT, readBody } from "../http.ts";
import { ulid } from "../ids.ts";
import { isRole, type Role } from "./roles.ts";
import { tenantDb, type TenantDb } from "./scope.ts";

export const INVITATION_TTL_MS = 7 * 86_400_000;
export const TRANSFER_TTL_MS = 7 * 86_400_000;

type SessionPrincipal = Principal & { kind: "tenant"; via: "session" };

async function objectBody(c: Context<Env>): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, JSON_LIMIT)));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ApiError) throw e;
  }
  throw invalid("body", "must be a JSON object");
}

/** A role that can be granted directly: owner only moves through a transfer. */
function grantable(v: unknown): Exclude<Role, "owner"> {
  if (!isRole(v)) throw invalid("role", "one of admin, developer, viewer");
  if (v === "owner") throw invalid("role", "ownership moves only through an owner transfer");
  return v;
}

async function roleOf(db: TenantDb, userId: string): Promise<Role | null> {
  const rows = await db.query<{ role: string }>("select role from memberships where tenant_id = $1 and user_id = $2", [db.tenantId, userId]);
  const r = rows[0]?.role;
  return isRole(r) ? r : null;
}

const session = (c: Context<Env>): SessionPrincipal => c.get("principal") as SessionPrincipal;

export function registerTeam(app: Hono<Env>, deps: Deps): void {
  app.get("/v1/team/members", operation(deps, "listMembers"), tenantAuth(deps, "team:read"), async (c) => {
    const db = tenantDb(deps, c);
    const rows = await db.query<{ user_id: string; email: string; role: string; created_at: unknown }>(
      "select m.user_id, u.email, m.role, m.created_at from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 order by m.created_at, m.user_id",
      [db.tenantId],
    );
    return c.json({ members: rows.map((r) => ({ user_id: r.user_id, email: r.email, role: r.role, created_at: num(r.created_at) })) });
  });

  app.post("/v1/team/invitations", operation(deps, "inviteMember"), tenantAuth(deps, "team:write"), async (c) => {
    const db = tenantDb(deps, c);
    const body = await objectBody(c);
    const email = emailField(body.email);
    const role = grantable(body.role);
    const now = deps.now();
    const value = newOneTimeValue();
    const id = `inv_${ulid(now)}`;
    await db.query(
      "insert into invitations (id, tenant_id, email, role, token_sha256, invited_by, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [id, db.tenantId, email, role, sha256hex(value), session(c).userId, now, now + INVITATION_TTL_MS],
    );
    c.set("auditTarget", { invitation_id: id, role });
    await sendInvitation(deps, email, db.tenantId, role, value);
    return c.json({ id, email, role, created_at: now, expires_at: now + INVITATION_TTL_MS }, 201);
  });

  app.get("/v1/team/invitations", operation(deps, "listInvitations"), tenantAuth(deps, "team:read"), async (c) => {
    const db = tenantDb(deps, c);
    const rows = await db.query<{ id: string; email: string; role: string; created_at: unknown; expires_at: unknown }>(
      "select id, email, role, created_at, expires_at from invitations where tenant_id = $1 and accepted_at is null and revoked_at is null and expires_at > $2 order by created_at",
      [db.tenantId, deps.now()],
    );
    return c.json({ invitations: rows.map((r) => ({ id: r.id, email: r.email, role: r.role, created_at: num(r.created_at), expires_at: num(r.expires_at) })) });
  });

  app.delete("/v1/team/invitations/:invitation_id", operation(deps, "revokeInvitation"), tenantAuth(deps, "team:write"), async (c) => {
    const db = tenantDb(deps, c);
    const rows = await db.query(
      "update invitations set revoked_at = $2 where tenant_id = $1 and id = $3 and accepted_at is null and revoked_at is null returning id",
      [db.tenantId, deps.now(), c.req.param("invitation_id")],
    );
    if (rows.length === 0) throw notFound();
    return c.body(null, 204);
  });

  app.put("/v1/team/members/:user_id", operation(deps, "changeMemberRole"), tenantAuth(deps, "team:write"), async (c) => {
    const db = tenantDb(deps, c);
    const userId = c.req.param("user_id");
    const role = grantable((await objectBody(c)).role);
    const from = await db.transaction(async (tx) => {
      const t = tx as TenantDb;
      const current = await roleOf(t, userId);
      if (current === null) throw notFound();
      if (current === "owner") throw conflict("role", "the owner's role changes only through an owner transfer");
      await t.query("update memberships set role = $3 where tenant_id = $1 and user_id = $2", [t.tenantId, userId, role]);
      return current;
    });
    c.set("auditTarget", { from, role });
    return c.json({ user_id: userId, role });
  });

  app.delete("/v1/team/members/:user_id", operation(deps, "removeMember"), tenantAuth(deps, "team:write"), async (c) => {
    const db = tenantDb(deps, c);
    const userId = c.req.param("user_id");
    await db.transaction(async (tx) => {
      const t = tx as TenantDb;
      const current = await roleOf(t, userId);
      if (current === null) throw notFound();
      if (current === "owner") throw conflict("role", "the owner cannot be removed; transfer ownership first");
      await t.query("delete from memberships where tenant_id = $1 and user_id = $2", [t.tenantId, userId]);
      // Their sessions leave the tenant; their tokens stop working (src/auth/middleware.ts).
      await t.query("update sessions set tenant_id = null where tenant_id = $1 and user_id = $2", [t.tenantId, userId]);
      await t.query("update owner_transfers set revoked_at = $2 where tenant_id = $1 and to_user = $3 and accepted_at is null and revoked_at is null", [t.tenantId, deps.now(), userId]);
    });
    return c.body(null, 204);
  });

  app.post("/v1/team/owner-transfer", operation(deps, "proposeOwnerTransfer"), tenantAuth(deps, "team:write"), async (c) => {
    const db = tenantDb(deps, c);
    const me = session(c);
    if (me.role !== "owner") throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "role", reason: me.role }]);
    const to = (await objectBody(c)).user_id;
    if (typeof to !== "string" || to === me.userId || (await roleOf(db, to)) === null) throw notFound();
    const verified = await db.query("select 1 from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.user_id = $2 and u.email_verified_at is not null", [db.tenantId, to]);
    if (verified.length === 0) throw conflict("user_id", "the new owner has not verified their email address");
    const now = deps.now();
    await db.query("update owner_transfers set revoked_at = $2 where tenant_id = $1 and accepted_at is null and revoked_at is null and expires_at <= $2", [db.tenantId, now]);
    const id = `otr_${ulid(now)}`;
    const rows = await db.query(
      "insert into owner_transfers (id, tenant_id, from_user, to_user, created_at, expires_at) values ($1, $2, $3, $4, $5, $6) on conflict do nothing returning id",
      [id, db.tenantId, me.userId, to, now, now + TRANSFER_TTL_MS],
    );
    if (rows.length === 0) throw conflict("owner_transfer", "a transfer is already open; cancel it first");
    c.set("auditTarget", { transfer_id: id, to_user: to });
    const email = await db.query<{ email: string }>("select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.user_id = $2", [db.tenantId, to]);
    if (email[0] !== undefined) await sendOwnerTransfer(deps, email[0].email, db.tenantId);
    return c.json({ id, to_user: to, created_at: now, expires_at: now + TRANSFER_TTL_MS }, 201);
  });

  app.post("/v1/team/owner-transfer/accept", operation(deps, "acceptOwnerTransfer"), tenantAuth(deps, "team:read"), async (c) => {
    const db = tenantDb(deps, c);
    const me = session(c);
    const now = deps.now();
    const transfer = await db.transaction(async (tx) => {
      const t = tx as TenantDb;
      const rows = await t.query<{ id: string; from_user: string }>(
        "select id, from_user from owner_transfers where tenant_id = $1 and to_user = $2 and accepted_at is null and revoked_at is null and expires_at > $3 for update",
        [t.tenantId, me.userId, now],
      );
      const open = rows[0];
      if (open === undefined) throw notFound();
      if ((await roleOf(t, open.from_user)) !== "owner") throw conflict("owner_transfer", "the proposer is no longer the owner");
      // One owner at any time (memberships_one_owner): demote first.
      await t.query("update memberships set role = 'admin' where tenant_id = $1 and user_id = $2", [t.tenantId, open.from_user]);
      await t.query("update memberships set role = 'owner' where tenant_id = $1 and user_id = $2", [t.tenantId, me.userId]);
      await t.query("update owner_transfers set accepted_at = $2 where tenant_id = $1 and id = $3", [t.tenantId, now, open.id]);
      return open;
    });
    c.set("auditTarget", { transfer_id: transfer.id, from_user: transfer.from_user, role: "owner" });
    return c.json({ tenant_id: db.tenantId, owner: me.userId, previous_owner: transfer.from_user });
  });

  app.delete("/v1/team/owner-transfer", operation(deps, "cancelOwnerTransfer"), tenantAuth(deps, "team:write"), async (c) => {
    const db = tenantDb(deps, c);
    if (session(c).role !== "owner") throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "role", reason: session(c).role }]);
    const rows = await db.query(
      "update owner_transfers set revoked_at = $2 where tenant_id = $1 and accepted_at is null and revoked_at is null returning id",
      [db.tenantId, deps.now()],
    );
    if (rows.length === 0) throw notFound();
    return c.body(null, 204);
  });
}
