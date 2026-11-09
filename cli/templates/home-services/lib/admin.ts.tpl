// The back office (F7-128): the company's settings, its branches, and its
// people. The owner runs all of it from /admin (pages/admin).
//
// A person's app role is per branch: an `org`-scoped assignment in
// renox__role_assignments, which applies while the branch is the session's
// active organisation (docs/contracts/ops.md section 17). The seed's roles are
// global (they apply in every branch the person belongs to); changing a role
// replaces them and keeps them for the person's other branches.
import type { Authz, DbStatements, Storage } from "@renoxium/sdk";
import { audit, org, twofa } from "renox:modules";

import { schema, text } from "./forms";
import { DEFAULT_HOURS } from "./booking-sync";
import type { Branch } from "./scope";

export const STAFF_ROLES = ["owner", "branch_manager", "dispatcher", "technician", "accountant"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const isStaffRole = (r: unknown): r is StaffRole => typeof r === "string" && (STAFF_ROLES as readonly string[]).includes(r);

interface AdminCtx {
  readonly db: DbStatements;
  readonly authz: Pick<Authz, "roles">;
  readonly principal: { readonly id: string } | null;
}

const now = (): number => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- settings

export const SETTING_KEYS = ["brand_name", "brand_name_ar", "brand_color", "brand_footer_en", "brand_footer_ar", "sender_name", "accounts_email"] as const;

export type BrandingInput = Record<(typeof SETTING_KEYS)[number], string>;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/u;

/** The branding form: the colour is `#rrggbb` (anything else is a 422), the names and footers have limits, the accounts email is empty or an address. */
export const brandingSchema = schema<BrandingInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const v: BrandingInput = {
    brand_name: text(raw, "brand_name", 80),
    brand_name_ar: text(raw, "brand_name_ar", 80),
    brand_color: text(raw, "brand_color", 7),
    brand_footer_en: text(raw, "brand_footer_en", 200),
    brand_footer_ar: text(raw, "brand_footer_ar", 200),
    sender_name: text(raw, "sender_name", 80),
    accounts_email: text(raw, "accounts_email", 254),
  };
  if (v.brand_name === "" || v.brand_name.length > 80) errors.brand_name = "backoffice.err.brand_name";
  if (v.brand_name_ar.length > 80) errors.brand_name_ar = "backoffice.err.brand_name";
  if (!/^#[0-9a-fA-F]{6}$/u.test(v.brand_color)) errors.brand_color = "backoffice.err.color";
  if (v.brand_footer_en.length > 200) errors.brand_footer_en = "backoffice.err.footer";
  if (v.brand_footer_ar.length > 200) errors.brand_footer_ar = "backoffice.err.footer";
  if (v.sender_name.length > 80 || /[<>\r\n]/u.test(v.sender_name)) errors.sender_name = "backoffice.err.sender";
  if (v.accounts_email !== "" && !EMAIL.test(v.accounts_email)) errors.accounts_email = "backoffice.err.accounts_email";
  return Object.keys(errors).length > 0 ? { errors } : { value: v };
});

/** Writes the settings that changed, and records which keys (never the values of the text fields: a footer may hold anything). Returns the keys. */
export async function saveSettings(ctx: AdminCtx, current: Record<string, string>, next: Partial<Record<string, string>>): Promise<string[]> {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || current[key] === value) continue;
    await ctx.db.execute("insert into app__settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", [key, value]);
    changed.push(key);
  }
  if (changed.length > 0) {
    await audit.record({ action: "settings.update", actor: { kind: "user", id: ctx.principal?.id ?? "unknown" }, resource: { type: "Settings", id: "branding" }, details: { keys: changed } });
  }
  return changed;
}

/** What the platform's storage accepts for a logo, by content type. The gateway refuses a body over 1 MiB (issue #574), so the limit is below it. */
export const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const MAX_LOGO_BYTES = 512 * 1024;

export type LogoResult = { ok: true; key: string } | { ok: false; error: "type" | "size" | "empty" | "storage" };

/** Stores the logo under `app/brand/` as a public image (the layout loads it through `/_img`), and deletes the one it replaces. */
export async function storeLogo(storage: Pick<Storage, "put" | "delete">, upload: { type: string; bytes: Uint8Array }, previous: string): Promise<LogoResult> {
  const ext = LOGO_TYPES[upload.type];
  if (ext === undefined) return { ok: false, error: "type" };
  if (upload.bytes.length === 0) return { ok: false, error: "empty" };
  if (upload.bytes.length > MAX_LOGO_BYTES) return { ok: false, error: "size" };
  const path = `app/brand/logo-${Date.now().toString(36)}.${ext}`;
  try {
    await storage.put(path, upload.bytes, { contentType: upload.type, public: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "RENOX_STORAGE_TYPE" || code === "RENOX_STORAGE_TOO_LARGE" || code === "RENOX_STORAGE_QUOTA") return { ok: false, error: "storage" };
    throw e;
  }
  if (previous.startsWith("app/brand/") && previous !== path) await storage.delete(previous);
  return { ok: true, key: path };
}

// ---------------------------------------------------------------- branches

export interface BranchInput {
  name_en: string;
  name_ar: string;
  phone: string;
  emirate: string;
  area: string;
  address: string;
}

/** The emirate of a branch, as the seed and the branch row spell it. */
const EMIRATE_NAMES = {
  dubai: { en: "Dubai", ar: "دبي" },
  sharjah: { en: "Sharjah", ar: "الشارقة" },
  abu_dhabi: { en: "Abu Dhabi", ar: "أبوظبي" },
  ajman: { en: "Ajman", ar: "عجمان" },
  umm_al_quwain: { en: "Umm Al Quwain", ar: "أم القيوين" },
  ras_al_khaimah: { en: "Ras Al Khaimah", ar: "رأس الخيمة" },
  fujairah: { en: "Fujairah", ar: "الفجيرة" },
} as const;
const EMIRATE_CODES = Object.keys(EMIRATE_NAMES);

export const branchEmirates = (locale: string): { code: string; name: string }[] => EMIRATE_CODES.map((code) => ({ code, name: EMIRATE_NAMES[code as keyof typeof EMIRATE_NAMES][locale === "ar" ? "ar" : "en"] }));

export const branchSchema = schema<BranchInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const v: BranchInput = {
    name_en: text(raw, "name_en", 80),
    name_ar: text(raw, "name_ar", 80),
    phone: text(raw, "phone", 20),
    emirate: text(raw, "emirate", 20),
    area: text(raw, "area", 80),
    address: text(raw, "address", 200),
  };
  if (v.name_en === "" || v.name_en.length > 80) errors.name_en = "backoffice.err.branch_name";
  if (v.name_ar === "" || v.name_ar.length > 80) errors.name_ar = "backoffice.err.branch_name";
  if (v.phone !== "" && !/^\+?[0-9 ]{6,20}$/u.test(v.phone)) errors.phone = "backoffice.err.branch_phone";
  if (!EMIRATE_CODES.includes(v.emirate)) errors.emirate = "backoffice.err.branch_emirate";
  if (v.area.length > 80) errors.area = "backoffice.err.branch_area";
  if (v.address.length > 200) errors.address = "backoffice.err.branch_address";
  return Object.keys(errors).length > 0 ? { errors } : { value: v };
});

export type BranchRow = Branch & { phone: string; address: string };

export async function allBranches(db: DbStatements): Promise<BranchRow[]> {
  return db.query<BranchRow>("select id, org_id, name_en, name_ar, slug, emirate, area, phone, address from app__branches order by created_at, id", []);
}

/**
 * A new branch: an `org` organisation (the owner becomes its owner and it
 * becomes the active one, so the previous one is made active again), the
 * branch row, and the standard working hours.
 */
export async function createBranch(ctx: AdminCtx, input: BranchInput, activeOrg: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const slugBase = input.name_en.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
  if (slugBase === "") return { ok: false, error: "backoffice.err.branch_name" };
  if ((await ctx.db.queryOne<{ n: number }>("select count(*) as n from app__branches where slug = ?", [slugBase]))?.n !== 0) return { ok: false, error: "backoffice.err.branch_exists" };
  const made = (await org.createOrg({ name: input.name_en, slug: slugBase })) as { org?: { id: string; slug: string }; error?: string };
  const created = made.org;
  if (created === undefined) return { ok: false, error: "backoffice.err.branch_exists" };
  await org.switchOrg(activeOrg);
  const id = `br_${created.slug.replace(/-/gu, "_")}`;
  await ctx.db.execute("insert into app__branches (id, org_id, name_en, name_ar, phone, address, emirate, area, slug, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, created.id, input.name_en, input.name_ar, input.phone, input.address, input.emirate, input.area, created.slug, now()]);
  for (const h of DEFAULT_HOURS) await ctx.db.execute("insert into app__branch_hours (branch_id, weekday, open_min, close_min) values (?, ?, ?, ?)", [id, h.weekday, h.open_min, h.close_min]);
  await audit.record({ action: "branch.create", actor: { kind: "user", id: ctx.principal?.id ?? "unknown" }, resource: { type: "Branch", id }, details: { slug: created.slug } });
  return { ok: true, id };
}

/** Changes a branch's own fields. The English name is the organisation's name too (`org.rename`); its slug (the dispatch socket's URL) and its organisation do not change. */
export async function updateBranch(ctx: AdminCtx, id: string, input: BranchInput): Promise<boolean> {
  const won = await ctx.db.execute("update app__branches set name_en = ?, name_ar = ?, phone = ?, address = ?, emirate = ?, area = ? where id = ?", [input.name_en, input.name_ar, input.phone, input.address, input.emirate, input.area, id]);
  if (won.changes !== 1) return false;
  const branch = await ctx.db.queryOne<{ org_id: string }>("select org_id from app__branches where id = ?", [id]);
  if (branch !== null) {
    const renamed = (await org.rename({ org: branch.org_id, name: input.name_en })) as { error?: string };
    if (renamed.error !== undefined) throw new Error(`org.rename: ${renamed.error}`);
  }
  await audit.record({ action: "branch.update", actor: { kind: "user", id: ctx.principal?.id ?? "unknown" }, resource: { type: "Branch", id } });
  return true;
}

// ------------------------------------------------------------------ people

export interface StaffRow {
  user_id: string;
  name: string;
  email: string;
  /** The app roles in effect in this branch (global or scoped to it). */
  roles: string[];
  twofa: boolean;
  self: boolean;
}

/** The roles of a person that apply in `branch`. */
async function rolesIn(ctx: AdminCtx, userId: string, branch: Branch): Promise<string[]> {
  const held = await ctx.authz.roles.list(userId);
  return held.filter((r) => isStaffRole(r.role) && (r.scope_type === "global" || r.scope_id === branch.org_id)).map((r) => r.role);
}

/** The branch's members with their roles and whether they have a second factor. Needs the caller to be a member (`org.members`). */
export async function staffOf(ctx: AdminCtx, branch: Branch): Promise<StaffRow[]> {
  const members = await org.members(branch.org_id);
  const out: StaffRow[] = [];
  for (const m of members) {
    out.push({ user_id: m.user_id, name: m.display_name, email: m.email, roles: await rolesIn(ctx, m.user_id, branch), twofa: await twofa.isEnrolled(m.user_id), self: m.user_id === ctx.principal?.id });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

/**
 * Makes `role` the person's only app role in `branch` (null: no role). A
 * global assignment is replaced by one scoped to each of the person's other
 * branches, so it keeps applying there.
 */
export async function setStaffRole(ctx: AdminCtx, branch: Branch, userId: string, role: StaffRole | null): Promise<void> {
  const here = { type: "org", id: branch.org_id };
  const held = await ctx.authz.roles.list(userId);
  const others = ((await org.listOrgs(userId)) as { id: string }[]).filter((o) => o.id !== branch.org_id);
  for (const r of held) {
    if (!isStaffRole(r.role)) continue;
    if (r.scope_type === "global") {
      await ctx.authz.roles.revoke(userId, r.role);
      for (const o of others) await ctx.authz.roles.assign(userId, r.role, { type: "org", id: o.id });
    } else if (r.scope_type === "org" && r.scope_id === branch.org_id && r.role !== role) {
      await ctx.authz.roles.revoke(userId, r.role, here);
    }
  }
  if (role !== null) await ctx.authz.roles.assign(userId, role, here);
}

export type InviteResult = { ok: true; applied: boolean } | { ok: false; error: string };

const MAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/u;

/**
 * Invites `email` to the branch through `org` (as a member) and remembers the
 * app role. When the person already has an account the role is assigned at
 * once (a branch-scoped role has no effect before they join); otherwise it is
 * applied by `claimInvites` once they have joined.
 */
export async function inviteStaff(ctx: AdminCtx, sdb: DbStatements, branch: Branch, email: string, role: StaffRole): Promise<InviteResult> {
  if (!MAIL.test(email)) return { ok: false, error: "backoffice.err.email" };
  const sent = (await org.invite({ org: branch.org_id, email, role: "member" })) as { invite_id?: string; error?: string };
  if (sent.invite_id === undefined) return { ok: false, error: "backoffice.err.invite" };
  await sdb.execute("insert into app__staff_invites (branch_id, org_id, email, role, invited_by, created_at, applied_at) values (?, ?, ?, ?, ?, ?, null)", [branch.id, branch.org_id, email, role, ctx.principal?.id ?? "unknown", now()]);
  await audit.record({ action: "staff.invite", actor: { kind: "user", id: ctx.principal?.id ?? "unknown" }, resource: { type: "Branch", id: branch.id }, details: { role, invite: sent.invite_id } });
  const known = await ctx.db.queryOne<{ id: string }>("select id from auth__public_users_v1 where lower(email) = lower(?)", [email]);
  if (known === null) return { ok: true, applied: false };
  await setStaffRole(ctx, branch, known.id, role);
  await sdb.execute("update app__staff_invites set applied_at = ? where branch_id = ? and lower(email) = lower(?) and applied_at is null", [now(), branch.id, email]);
  return { ok: true, applied: true };
}

/** Pending invitations of the branch, newest first. */
export async function pendingInvites(sdb: DbStatements, branchId: string): Promise<{ email: string; role: string; created_at: number }[]> {
  return sdb.query("select email, role, created_at from app__staff_invites where branch_id = ? and applied_at is null order by id desc", [branchId]);
}

/**
 * The roles chosen for people who have joined since: a member whose email has
 * a pending invitation gets its role. `org` emits an event when a member is
 * added, but an app cannot subscribe to events, so this runs when the owner opens the users
 * page (docs/contracts/ops.md section 15).
 */
export async function claimInvites(ctx: AdminCtx, sdb: DbStatements, branch: Branch, staff: readonly StaffRow[]): Promise<number> {
  const pending = await sdb.query<{ id: number; email: string; role: string }>("select id, email, role from app__staff_invites where branch_id = ? and applied_at is null order by id", [branch.id]);
  let claimed = 0;
  for (const p of pending) {
    const member = staff.find((s) => s.email.toLowerCase() === p.email.toLowerCase());
    if (member === undefined || !isStaffRole(p.role)) continue;
    await setStaffRole(ctx, branch, member.user_id, p.role);
    await sdb.execute("update app__staff_invites set applied_at = ? where id = ?", [now(), p.id]);
    claimed += 1;
  }
  return claimed;
}

/** Takes the person out of the branch: no role, no membership (the last owner of the organisation stays: `org` refuses). */
export async function removeStaff(ctx: AdminCtx, branch: Branch, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const gone = (await org.removeMember({ org: branch.org_id, user: userId })) as { ok?: boolean; error?: string };
  if (gone.ok !== true) return { ok: false, error: "backoffice.err.remove" };
  await setStaffRole(ctx, branch, userId, null);
  await audit.record({ action: "staff.remove", actor: { kind: "user", id: ctx.principal?.id ?? "unknown" }, resource: { type: "Branch", id: branch.id }, details: { user: userId } });
  return { ok: true };
}

// ---------------------------------------------------------------- the dashboard

export interface Tiles {
  jobs_today: number;
  open_invoices: number;
  amc_renewals: number;
}

/** The three numbers of the dashboard for a branch: today's jobs, invoices not yet paid, active contracts that end this month (Dubai days). */
export async function tiles(db: DbStatements, branchId: string, today: string): Promise<Tiles> {
  const startOfDay = Math.floor(Date.parse(`${today}T00:00:00Z`) / 1000) - 4 * 3600;
  const month = today.slice(0, 7);
  const one = async (sql: string, params: (string | number)[]): Promise<number> => (await db.queryOne<{ n: number }>(sql, params))?.n ?? 0;
  return {
    jobs_today: await one("select count(*) as n from app__jobs where branch_id = ? and status != 'cancelled' and scheduled_start >= ? and scheduled_start < ?", [branchId, startOfDay, startOfDay + 86_400]),
    open_invoices: await one("select count(*) as n from app__invoice_status where branch_id = ? and status in ('issued', 'part-paid')", [branchId]),
    amc_renewals: await one("select count(*) as n from app__contracts where branch_id = ? and status = 'active' and substr(ends_on, 1, 7) = ?", [branchId, month]),
  };
}

// ---------------------------------------------------------------- guards

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * The 403 of a refused policy decision, or null when `action` is allowed (and
 * then the second factor is asked for: without a recent one the step-up throws
 * its own 403). `action` is sensitive, so every decision is audited.
 */
export async function sensitive(ctx: { readonly authz: Pick<Authz, "require"> }, action: "settings.write" | "user.manage", next: string): Promise<Response | null> {
  try {
    await ctx.authz.require(action);
  } catch (e) {
    if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return plain(403, "Forbidden");
    throw e;
  }
  await twofa.requireRecent({ next });
  return null;
}

/** The actions the app audits, for the filter. */
export const AUDITED = ["invoice.issue", "invoice.pay", "invoice.credit", "settings.write", "settings.update", "user.manage", "staff.invite", "staff.remove", "branch.create", "branch.update", "job.transition", "quote.link_answer", "contract.activate", "report.export"] as const;
