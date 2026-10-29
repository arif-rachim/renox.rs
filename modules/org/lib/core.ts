// The org module's logic, shared by services.ts and the pages (#242;
// docs/18-build-plan.md M2).
//
// - Users and sessions are auth's: the signed-in user and the session id
//   come from `auth.currentSession()`. The active organisation is stored
//   per auth session in `org__active`, so it ends with the session.
// - Every read and write checks the caller's membership here: the SQLite
//   authorizer fences tables by module, not rows by organisation, so this
//   check is the fence between organisations until F5 `db.scoped`
//   (docs/11-authorization.md).
// - Roles: member < admin < owner. Admins invite and manage members but
//   never touch an owner; only an owner grants or removes `owner`. The last
//   owner of an organisation cannot be removed or demoted (one statement,
//   so two concurrent removals cannot both pass the check).
// - Invitations: 32 random bytes, only the SHA-256 stored, single use (one
//   conditional UPDATE), `invite_days` (7) to accept, for the invited email.

import type { DbStatements } from "renox";
import { auth } from "renox:modules";

export interface OrgCtx {
  db: DbStatements;
  headers: Headers;
  config: Readonly<Record<string, unknown>>;
  url?: URL;
  events: { emit(name: string, payload: Record<string, unknown>, options?: { durable?: boolean }): Promise<string> };
  hooks: { run(name: string, args: unknown): Promise<{ halt: false } | { halt: true; response: Response; module: string }> };
}

export type Role = "owner" | "admin" | "member";
export const ROLES: readonly Role[] = ["owner", "admin", "member"];
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);
export const atLeast = (role: Role, min: Role): boolean => RANK[role] >= RANK[min];

export interface User {
  id: string;
  email: string;
  display_name: string;
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  role: Role;
  /** The default locale (#244), or null. */
  locale: string | null;
}

/** `currentOrg`: the organisation, the user's role, and `scope` for the F5 authz context. */
export interface CurrentOrg extends Org {
  scope: { org_id: string; role: Role };
}

/** A refused call: `ORG_FORBIDDEN` (403), `AUTH_REQUIRED` (401). */
export class OrgError extends Error {
  constructor(
    readonly code: "ORG_FORBIDDEN" | "AUTH_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "OrgError";
  }
  get status(): number {
    return this.code === "AUTH_REQUIRED" ? 401 : 403;
  }
}

const now = (): number => Math.floor(Date.now() / 1000);

export function randomHex(n: number): string {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let s = "";
  for (const x of d) s += x.toString(16).padStart(2, "0");
  return s;
}

const intConfig = (ctx: OrgCtx, key: string, fallback: number): number => {
  const v = ctx.config[key];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : fallback;
};

/** Where the app mounts org's pages (config `base_path`, `/org`). */
export function basePath(ctx: Pick<OrgCtx, "config">): string {
  const p = ctx.config.base_path;
  return typeof p === "string" && /^\/[A-Za-z0-9/_-]*$/u.test(p) ? p.replace(/\/+$/u, "") || "/org" : "/org";
}

/** A path of the app (`/x`, not `//host` or `/\host`), else `fallback`. */
export const safePath = (next: unknown, fallback = "/"): string =>
  typeof next === "string" && /^\/(?![/\\])[^\s]*$/u.test(next) && next.length <= 2000 ? next : fallback;

/** The signed-in user's auth session, or null. */
export async function session(): Promise<{ id: string; user: User } | null> {
  return (await auth.currentSession()) as { id: string; user: User } | null;
}

export async function requireSession(): Promise<{ id: string; user: User }> {
  const s = await session();
  if (s === null) throw new OrgError("AUTH_REQUIRED", "sign in first");
  return s;
}

/** The user's role in `orgId`, or null when not a member. */
export async function roleOf(ctx: OrgCtx, orgId: string, userId: string): Promise<Role | null> {
  const r = await ctx.db.queryOne<{ role: Role }>("select role from org__members where org_id = ? and user_id = ?", [orgId, userId]);
  return r?.role ?? null;
}

/** Throws ORG_FORBIDDEN unless `userId` is a member of `orgId` with at least `min`. */
export async function requireRole(ctx: OrgCtx, orgId: string, userId: string, min: Role): Promise<Role> {
  const role = typeof orgId === "string" ? await roleOf(ctx, orgId, userId) : null;
  if (role === null || !atLeast(role, min)) throw new OrgError("ORG_FORBIDDEN", "not allowed in this organisation");
  return role;
}

export async function listOrgs(ctx: OrgCtx, userId: string): Promise<Org[]> {
  return ctx.db.query<Org>(
    "select o.id, o.slug, o.name, m.role, o.locale from org__members m join org__orgs o on o.id = m.org_id where m.user_id = ? order by o.name, o.id",
    [String(userId)],
  );
}

/**
 * The active organisation of this session: the one chosen with switchOrg
 * while the user is still its member, else the user's first organisation
 * (by joining date). Null when signed out or a member of none.
 */
export async function currentOrg(ctx: OrgCtx): Promise<CurrentOrg | null> {
  const s = await session();
  if (s === null) return null;
  const sql = "select o.id, o.slug, o.name, m.role, o.locale from org__members m join org__orgs o on o.id = m.org_id where m.user_id = ?";
  const org =
    (await ctx.db.queryOne<Org>(`${sql} and o.id = (select org_id from org__active where session_id = ?)`, [s.user.id, s.id])) ??
    (await ctx.db.queryOne<Org>(`${sql} order by m.created_at, o.id limit 1`, [s.user.id]));
  return org === null ? null : { ...org, scope: { org_id: org.id, role: org.role } };
}

export async function requireMember(ctx: OrgCtx, min: Role = "member"): Promise<CurrentOrg> {
  await requireSession();
  const org = await currentOrg(ctx);
  if (org === null || !atLeast(org.role, isRole(min) ? min : "member")) throw new OrgError("ORG_FORBIDDEN", "not a member of the active organisation with that role");
  return org;
}

async function setActive(ctx: OrgCtx, sessionId: string, orgId: string): Promise<void> {
  await ctx.db.execute("insert into org__active (session_id, org_id, updated_at) values (?, ?, ?) on conflict (session_id) do update set org_id = excluded.org_id, updated_at = excluded.updated_at", [
    sessionId,
    orgId,
    now(),
  ]);
}

export async function switchOrg(ctx: OrgCtx, orgId: string): Promise<{ ok: true; org: Org } | { ok: false; error: string }> {
  const s = await requireSession();
  const org = (await listOrgs(ctx, s.user.id)).find((o) => o.id === orgId);
  if (org === undefined) return { ok: false, error: "You are not a member of that organisation." };
  await setActive(ctx, s.id, org.id);
  return { ok: true, org };
}

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 50)
    .replace(/-+$/u, "");
}

export async function createOrg(ctx: OrgCtx, input: { name?: unknown; slug?: unknown }): Promise<{ ok: true; org: Org } | { ok: false; error: string }> {
  const s = await requireSession();
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 100) return { ok: false, error: "Give the organisation a name of 1 to 100 characters." };
  const slug = slugify(typeof input?.slug === "string" && input.slug.trim() !== "" ? input.slug : name);
  if (slug === "") return { ok: false, error: "Choose a short name of letters and digits for its address." };
  if ((await ctx.db.queryOne("select 1 as x from org__orgs where slug = ?", [slug])) !== null) return { ok: false, error: "That address is taken. Choose another." };
  const id = randomHex(16);
  const t = now();
  await ctx.db.execute("insert into org__orgs (id, slug, name, created_by, created_at) values (?, ?, ?, ?, ?)", [id, slug, name, s.user.id, t]);
  await ctx.db.execute("insert into org__members (org_id, user_id, role, created_at) values (?, ?, 'owner', ?)", [id, s.user.id, t]);
  await setActive(ctx, s.id, id);
  await ctx.events.emit("org.created", { org_id: id, user_id: s.user.id, at: t });
  await ctx.events.emit("org.member_added", { org_id: id, user_id: s.user.id, role: "owner", at: t });
  return { ok: true, org: { id, slug, name, role: "owner", locale: null } };
}

export interface Member {
  user_id: string;
  display_name: string;
  email: string;
  role: Role;
}

/** The members of `orgId`; throws ORG_FORBIDDEN unless the caller is one (org.read). */
export async function members(ctx: OrgCtx, orgId: string): Promise<Member[]> {
  const s = await requireSession();
  await requireRole(ctx, orgId, s.user.id, "member");
  return ctx.db.query<Member>(
    `select m.user_id, coalesce(u.display_name, '') as display_name, coalesce(u.email, '') as email, m.role
     from org__members m left join auth__public_users_v1 u on u.id = m.user_id
     where m.org_id = ? order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.display_name, m.user_id`,
    [orgId],
  );
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  expires_at: number;
}

/** Pending invitations of `orgId` (admin or owner). */
export async function pendingInvites(ctx: OrgCtx, orgId: string): Promise<Invite[]> {
  const s = await requireSession();
  await requireRole(ctx, orgId, s.user.id, "admin");
  return ctx.db.query<Invite>(
    "select id, email, role, expires_at from org__invites where org_id = ? and accepted_at is null and revoked_at is null and expires_at > ? order by created_at, id",
    [orgId, now()],
  );
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/u;

/** The invitation mail, through `org.send_mail` (the app or a mail module fills it). */
export interface Mail {
  to: string;
  template: "org_invite";
  args: { url: string; org_name: string; role: Role; expires_days: number; invited_by: string };
}

/**
 * Invite `email` to `org` as `role` (admin or owner; only an owner invites
 * an owner). `org.before_invite` may halt. A pending invitation for the same
 * email is replaced. The raw token is only in the mail.
 */
export async function invite(
  ctx: OrgCtx & { url: URL },
  input: { org?: unknown; email?: unknown; role?: unknown },
): Promise<{ ok: true; invite_id: string; expires_at: number } | { ok: false; error: string; halt?: Response }> {
  const s = await requireSession();
  return inviteAs(ctx, s.user, ctx.url.origin, input);
}

/**
 * `invite` as `user` (the session's, or an agent's: the `invite_member`
 * tool, #286). `origin` builds the accept link; without one (no request)
 * the link is the app path and the mail module prefixes the app's host.
 */
export async function inviteAs(
  ctx: OrgCtx,
  user: Pick<User, "id" | "display_name">,
  origin: string | null,
  input: { org?: unknown; email?: unknown; role?: unknown },
): Promise<{ ok: true; invite_id: string; expires_at: number } | { ok: false; error: string; halt?: Response }> {
  const s = { user };
  const orgId = String(input?.org ?? "");
  const mine = await requireRole(ctx, orgId, s.user.id, "admin");
  const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  const role = isRole(input?.role) ? input.role : "member";
  if (role === "owner" && mine !== "owner") throw new OrgError("ORG_FORBIDDEN", "only an owner invites an owner");
  const hook = await ctx.hooks.run("org.before_invite", { org_id: orgId, email, role, invited_by: s.user.id });
  if (hook.halt) return { ok: false, error: "The invitation was not sent.", halt: hook.response };
  const t = now();
  await ctx.db.execute("update org__invites set revoked_at = ? where org_id = ? and email = ? and accepted_at is null and revoked_at is null", [t, orgId, email]);
  const token = randomHex(32);
  const id = randomHex(16);
  const days = intConfig(ctx, "invite_days", 7);
  const expires = t + days * 86400;
  await ctx.db.execute(
    "insert into org__invites (id, org_id, token_hash, email, role, invited_by, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, orgId, await sha256Hex(token), email, role, s.user.id, expires, t],
  );
  const org = await ctx.db.queryOne<{ name: string }>("select name from org__orgs where id = ?", [orgId]);
  const mail: Mail = {
    to: email,
    template: "org_invite",
    args: { url: `${origin ?? ""}${basePath(ctx)}/accept/${token}`, org_name: org?.name ?? "", role, expires_days: days, invited_by: s.user.display_name },
  };
  await ctx.hooks.run("org.send_mail", mail);
  return { ok: true, invite_id: id, expires_at: expires };
}

export async function revokeInvite(ctx: OrgCtx, input: { org?: unknown; invite?: unknown }): Promise<void> {
  const s = await requireSession();
  const orgId = String(input?.org ?? "");
  await requireRole(ctx, orgId, s.user.id, "admin");
  await ctx.db.execute("update org__invites set revoked_at = ? where id = ? and org_id = ? and accepted_at is null and revoked_at is null", [now(), String(input?.invite ?? ""), orgId]);
}

/** The live invitation of `token`, without using it (the accept page shows it). */
export async function peekInvite(ctx: OrgCtx, token: string): Promise<{ org_name: string; role: Role; email: string } | null> {
  if (!/^[0-9a-f]{64}$/u.test(token)) return null;
  return ctx.db.queryOne<{ org_name: string; role: Role; email: string }>(
    "select o.name as org_name, i.role, i.email from org__invites i join org__orgs o on o.id = i.org_id where i.token_hash = ? and i.accepted_at is null and i.revoked_at is null and i.expires_at > ?",
    [await sha256Hex(token), now()],
  );
}

export const INVITE_INVALID = "This invitation has expired, was already used, or is for another email address.";

/**
 * Accept `token` as the signed-in user: once, before it expires, and only
 * for the invited email. The user joins with the invited role (an existing
 * member keeps their role) and the organisation becomes active.
 */
export async function acceptInvite(ctx: OrgCtx, token: string): Promise<{ ok: true; org: Org } | { ok: false; error: string }> {
  const s = await requireSession();
  if (!/^[0-9a-f]{64}$/u.test(token)) return { ok: false, error: INVITE_INVALID };
  const hash = await sha256Hex(token);
  const t = now();
  const r = await ctx.db.execute(
    "update org__invites set accepted_at = ?, accepted_by = ? where token_hash = ? and accepted_at is null and revoked_at is null and expires_at > ? and email = ?",
    [t, s.user.id, hash, t, s.user.email],
  );
  if (r.changes !== 1) return { ok: false, error: INVITE_INVALID };
  const inv = await ctx.db.queryOne<{ org_id: string; role: Role }>("select org_id, role from org__invites where token_hash = ?", [hash]);
  if (inv === null) return { ok: false, error: INVITE_INVALID };
  const added = await ctx.db.execute("insert or ignore into org__members (org_id, user_id, role, created_at) values (?, ?, ?, ?)", [inv.org_id, s.user.id, inv.role, t]);
  if (added.changes === 1) await ctx.events.emit("org.member_added", { org_id: inv.org_id, user_id: s.user.id, role: inv.role, at: t });
  await setActive(ctx, s.id, inv.org_id);
  const org = (await listOrgs(ctx, s.user.id)).find((o) => o.id === inv.org_id) as Org;
  return { ok: true, org };
}

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;

/** Set `org`'s default locale (admin or owner); null or "" clears it. */
export async function setOrgLocale(ctx: OrgCtx, input: { org?: unknown; locale?: unknown }): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await requireSession();
  const orgId = String(input?.org ?? "");
  await requireRole(ctx, orgId, s.user.id, "admin");
  const locale = input?.locale === null || input?.locale === "" ? null : String(input?.locale ?? "");
  if (locale !== null && (!LOCALE.test(locale) || locale.length > 35)) return { ok: false, error: "Choose a language such as en or ar." };
  await ctx.db.execute("update org__orgs set locale = ? where id = ?", [locale, orgId]);
  return { ok: true };
}

export const LAST_OWNER = "An organisation keeps at least one owner: make someone else owner first.";

/** Change `user`'s role in `org`. Admins manage admins and members only; an owner manages everyone. */
export async function setRole(ctx: OrgCtx, input: { org?: unknown; user?: unknown; role?: unknown }): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await requireSession();
  const orgId = String(input?.org ?? "");
  const userId = String(input?.user ?? "");
  const mine = await requireRole(ctx, orgId, s.user.id, "admin");
  if (!isRole(input?.role)) return { ok: false, error: "Choose owner, admin, or member." };
  const role = input.role;
  const theirs = await roleOf(ctx, orgId, userId);
  if (theirs === null) return { ok: false, error: "That user is not a member." };
  if (mine !== "owner" && (theirs === "owner" || role === "owner")) throw new OrgError("ORG_FORBIDDEN", "only an owner grants or removes owner");
  // Demoting an owner: one statement, so the last owner always stays.
  const r = await ctx.db.execute(
    "update org__members set role = ? where org_id = ? and user_id = ? and (role <> 'owner' or ? = 'owner' or (select count(*) from org__members where org_id = ? and role = 'owner') > 1)",
    [role, orgId, userId, role, orgId],
  );
  return r.changes === 1 ? { ok: true } : { ok: false, error: LAST_OWNER };
}

/** Remove `user` from `org` (admin or owner), or leave it (`user` = the caller). The last owner stays. */
export async function removeMember(ctx: OrgCtx, input: { org?: unknown; user?: unknown }): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await requireSession();
  const orgId = String(input?.org ?? "");
  const userId = String(input?.user ?? "");
  const mine = await requireRole(ctx, orgId, s.user.id, userId === s.user.id ? "member" : "admin");
  const theirs = await roleOf(ctx, orgId, userId);
  if (theirs === null) return { ok: false, error: "That user is not a member." };
  if (userId !== s.user.id && theirs === "owner" && mine !== "owner") throw new OrgError("ORG_FORBIDDEN", "only an owner removes an owner");
  const r = await ctx.db.execute(
    "delete from org__members where org_id = ? and user_id = ? and (role <> 'owner' or (select count(*) from org__members where org_id = ? and role = 'owner') > 1)",
    [orgId, userId, orgId],
  );
  if (r.changes !== 1) return { ok: false, error: LAST_OWNER };
  await ctx.events.emit("org.member_removed", { org_id: orgId, user_id: userId, by: s.user.id, at: now() });
  return { ok: true };
}

/** The switcher partial's data (`org_switcher` in a page's load). */
export interface Switcher {
  orgs: { id: string; name: string; role: Role; current: boolean }[];
  has_orgs: boolean;
  current: CurrentOrg | null;
  can_manage: boolean;
  action: string;
  base: string;
  members_url: string;
  next: string;
}

export async function switcher(ctx: OrgCtx, next?: unknown): Promise<Switcher | null> {
  const s = await session();
  if (s === null) return null;
  const current = await currentOrg(ctx);
  const orgs = (await listOrgs(ctx, s.user.id)).map((o) => ({ id: o.id, name: o.name, role: o.role, current: o.id === current?.id }));
  const base = basePath(ctx);
  return {
    orgs,
    has_orgs: orgs.length > 0,
    current,
    can_manage: current !== null && atLeast(current.role, "admin"),
    action: `${base}?/switch`,
    base,
    members_url: `${base}/members`,
    next: safePath(next),
  };
}
