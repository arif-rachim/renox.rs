// The company's first data, from the platform (#711; deploy-api.md section
// 21): `POST /api/setup` (functions/api/setup.ts) once, with a one-time token
// (lib/setup-token.ts), when the owner creates the app from the dashboard or
// the platform's MCP tool. The demo seed is never loaded.
//
// One step, one transaction (`writeSetup`): the settings (brand name, phone,
// TRN, emirate, and `setup_hash`, the deployment hash the token names), the
// services, the owner's account (`auth.register`: its mail carries the
// sign-in link) with the global role `owner`, then `org.bootstrap` (the
// system-only service of `org` 1.2.0, #747) for one organisation per branch
// with the owner as its owner and the invitations of the people to the first
// branch, then the branch rows with their working hours and, for each person,
// the `app__staff_invites` row with their app role (applied when they accept,
// lib/admin.ts `applyPendingRole`). A failure anywhere rolls all of it back.
import type { Authz, DbStatements, TxDb } from "@renoxium/sdk";
import { audit, auth, org } from "renox:modules";

import { STAFF_ROLES, type StaffRole } from "./admin";
import { DEFAULT_HOURS } from "./booking-sync";
import { branchDb } from "./scope";

export const EMIRATES = ["abu_dhabi", "dubai", "sharjah", "ajman", "umm_al_quwain", "ras_al_khaimah", "fujairah"] as const;

/**
 * The roles a person may be given: the app's `[authz.default_roles]`, and
 * `manager`, the contract's name (`HomeServicesSetup`) for `branch_manager`.
 */
const ROLE_ALIASES: Readonly<Record<string, StaffRole>> = { manager: "branch_manager" };

export interface SetupInput {
  company: { name: string; trn: string; phone: string; emirate: string };
  branches: { name: string; emirate: string }[];
  services: { name: string; price_aed: number }[];
  people: { email: string; role: StaffRole }[];
  owner: { email: string };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/u;

/** The body checked against the limits of section 21, trimmed and with lower-cased addresses; or the errors by field path. */
export function parseSetup(body: unknown): { value: SetupInput } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const fail = (path: string, reason: string): void => {
    errors[path] ??= reason;
  };
  const only = (o: Obj, keys: string[], path: string): void => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${path}${k}`, "unknown field");
  };
  const text = (v: unknown, path: string): string => {
    const t = typeof v === "string" ? v.trim() : "";
    if (typeof v !== "string" || t.length < 1 || [...t].length > 80) fail(path, "1 to 80 characters");
    return t;
  };
  const emirate = (v: unknown, path: string): string => {
    if (typeof v !== "string" || !(EMIRATES as readonly string[]).includes(v)) fail(path, `one of ${EMIRATES.join(", ")}`);
    return String(v);
  };
  const list = (v: unknown, path: string, min: number, max: number): Obj[] => {
    if (!Array.isArray(v) || v.length < min || v.length > max) {
      fail(path, `${min} to ${max} items`);
      return [];
    }
    return v.flatMap((x, i) => {
      if (isObj(x)) return [x];
      fail(`${path}[${i}]`, "must be an object");
      return [];
    });
  };
  const email = (v: unknown, path: string): string => {
    const e = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (e.length > 254 || !EMAIL.test(e)) fail(path, "must be an email address");
    return e;
  };

  if (!isObj(body)) return { errors: { body: "must be a JSON object" } };
  only(body, ["company", "branches", "services", "people", "owner"], "");
  const c = isObj(body.company) ? body.company : {};
  if (!isObj(body.company)) fail("company", "must be an object");
  only(c, ["name", "trn", "phone", "emirate"], "company.");
  const company = { name: text(c.name, "company.name"), trn: "", phone: typeof c.phone === "string" ? c.phone.trim() : "", emirate: emirate(c.emirate, "company.emirate") };
  if (!/^\+[1-9][0-9]{7,14}$/u.test(company.phone)) fail("company.phone", "E.164, for example +971501234567");
  if (c.trn !== undefined) {
    company.trn = typeof c.trn === "string" ? c.trn.trim() : "";
    if (!/^[0-9]{15}$/u.test(company.trn)) fail("company.trn", "15 digits");
  }
  const branches = list(body.branches, "branches", 1, 5).map((b, i) => {
    only(b, ["name", "emirate"], `branches[${i}].`);
    return { name: text(b.name, `branches[${i}].name`), emirate: emirate(b.emirate, `branches[${i}].emirate`) };
  });
  const services = list(body.services, "services", 1, 50).map((s, i) => {
    only(s, ["name", "price_aed"], `services[${i}].`);
    const price = s.price_aed;
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1_000_000) fail(`services[${i}].price_aed`, "a number from 0 to 1000000");
    return { name: text(s.name, `services[${i}].name`), price_aed: Number(price) };
  });
  const seen = new Set<string>();
  const people = list(body.people, "people", 0, 20).map((p, i) => {
    only(p, ["email", "role"], `people[${i}].`);
    const address = email(p.email, `people[${i}].email`);
    if (seen.has(address)) fail(`people[${i}].email`, "listed twice");
    seen.add(address);
    const raw = typeof p.role === "string" ? p.role : "";
    const role = ROLE_ALIASES[raw] ?? ((STAFF_ROLES as readonly string[]).includes(raw) ? (raw as StaffRole) : null);
    if (role === null) fail(`people[${i}].role`, `one of ${[...Object.keys(ROLE_ALIASES), ...STAFF_ROLES].join(", ")}`);
    return { email: address, role: role ?? "technician" };
  });
  const o = isObj(body.owner) ? body.owner : {};
  if (!isObj(body.owner)) fail("owner", "must be an object");
  only(o, ["email"], "owner.");
  const owner = { email: email(o.email, "owner.email") };
  return Object.keys(errors).length > 0 ? { errors } : { value: { company, branches, services, people, owner } };
}

/** What the platform is answered (section 21): the people invited, and those left out with the reason. */
export interface SetupAnswer {
  invited: { email: string; role: string }[];
  skipped: { email: string; reason: string }[];
}

interface SetupCtx {
  readonly db: DbStatements & { transaction<T>(fn: (tx: TxDb) => Promise<T>): Promise<T> };
  readonly authz: Pick<Authz, "roles">;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** A slug of letters and digits for a branch's organisation (`branch-<n>` without any). */
const slugOf = (name: string, i: number): string =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "") || `branch-${i + 1}`;

/** One unique slug per branch (`dubai`, `dubai-2`): `org.bootstrap` refuses an explicit slug used twice in the call. */
function branchSlugs(branches: { name: string }[]): string[] {
  const taken = new Set<string>();
  return branches.map((b, i) => {
    const base = slugOf(b.name, i);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 46)}-${n}`;
    taken.add(slug);
    return slug;
  });
}

const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A unique service code from its name (`AC service` -> `AC-SERVICE`, `AC-SERVICE-2`, or `SERVICE-<n>` without a Latin letter or digit). */
export function serviceCode(name: string, i: number, taken: Set<string>): string {
  const base = name.normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 30) || `SERVICE-${i + 1}`;
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
  taken.add(code);
  return code;
}

/**
 * In one transaction: "taken" (409) when the app already holds its setup or
 * any user (a second call changes nothing); else the settings, the services,
 * the owner's account with the role `owner`, the branches as `org`
 * organisations with the invitations of the people (`org.bootstrap`), the
 * branch rows with their hours, and the people's app roles.
 */
export async function writeSetup(ctx: SetupCtx, input: SetupInput, hash: string): Promise<SetupAnswer | "taken"> {
  return ctx.db.transaction(async (tx) => {
    const done = await tx.queryOne<{ n: number }>("select (select count(*) from app__settings where key = 'setup_hash') + (select count(*) from auth__public_users_v1) + (select count(*) from app__branches) as n", []);
    if ((done?.n ?? 0) > 0) return "taken";

    const skipped = input.people.filter((p) => p.email === input.owner.email).map((p) => ({ email: p.email, reason: "the owner" }));
    const people = input.people.filter((p) => p.email !== input.owner.email);
    const settings: [string, string][] = [
      ["brand_name", input.company.name],
      ["company_phone", input.company.phone],
      ["company_trn", input.company.trn],
      ["company_emirate", input.company.emirate],
      ["setup_hash", hash],
    ];
    for (const [key, value] of settings) await tx.execute("insert into app__settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", [key, value]);

    const codes = new Set((await tx.query<{ code: string }>("select code from app__services", [])).map((r) => r.code));
    for (const [i, s] of input.services.entries()) {
      await tx.execute("insert into app__services (branch_id, code, name_en, name_ar, unit, price_fils, vat_rate, active) values (null, ?, ?, ?, 'visit', ?, 5, 1)", [serviceCode(s.name, i, codes), s.name, s.name, Math.round(s.price_aed * 100)]);
    }

    // The owner signs in with the link of the confirmation mail (or a reset); nobody knows this password.
    const registered = await auth.register({ email: input.owner.email, password: randomHex(32) });
    if ("error" in registered) throw new Error(`auth.register: ${registered.error}`);
    const owner = await tx.queryOne<{ id: string }>("select id from auth__public_users_v1 where email = ?", [input.owner.email]);
    if (owner === null) throw new Error("auth.register created no user");
    await ctx.authz.roles.assign(owner.id, "owner");

    // The branches are organisations and the people are invited to the first one as members; their app
    // role waits in app__staff_invites until they accept (the `org.member_added` handler, hooks.ts).
    const slugs = branchSlugs(input.branches);
    const boot = await org.bootstrap({
      owner_user_id: owner.id,
      orgs: input.branches.map((b, i) => ({ name: b.name, slug: slugs[i] as string })),
      invites: people.map((p) => ({ email: p.email, org_index: 0, role: "member" })),
    });
    const at = now();
    const made: string[] = [];
    for (const [i, b] of input.branches.entries()) {
      const o = boot.orgs[i];
      if (o === undefined) throw new Error("org.bootstrap created no organisation for a branch");
      const id = `br_${o.slug.replace(/-/gu, "_")}`;
      // The transaction's own statements (app__branches is no owned table; the app's `ctx.db.scoped()` is refused inside a transaction).
      await tx.execute("insert into app__branches (id, org_id, name_en, name_ar, phone, address, emirate, area, slug, created_at) values (?, ?, ?, ?, '', '', ?, '', ?, ?)", [id, o.id, b.name, b.name, b.emirate, o.slug, at]);
      for (const h of DEFAULT_HOURS) await tx.execute("insert into app__branch_hours (branch_id, weekday, open_min, close_min) values (?, ?, ?, ?)", [id, h.weekday, h.open_min, h.close_min]);
      made.push(id);
    }
    const first = boot.orgs[0];
    if (first === undefined) throw new Error("org.bootstrap created no organisation");
    const firstBranch = made[0];
    if (firstBranch === undefined) throw new Error("setup made no branch");
    // Fenced to the first branch, as lib/admin.ts inviteStaff writes the same row: `tx.scoped` runs in this
    // transaction (ops.md 1.15.0; typed TxDb since 1.17.1, #756).
    const sdb = branchDb(tx, firstBranch);
    for (const p of people) {
      await sdb.execute("insert into app__staff_invites (branch_id, org_id, email, role, invited_by, created_at, applied_at) values (?, ?, ?, ?, ?, ?, null)", [firstBranch, first.id, p.email, p.role, owner.id, at]);
    }
    await audit.record({ action: "setup.write", actor: { kind: "system", id: "platform" }, resource: { type: "Settings", id: "setup" }, details: { branches: made, services: input.services.length, invited: people.length } });
    return { invited: people.map((p) => ({ email: p.email, role: p.role })), skipped };
  });
}
