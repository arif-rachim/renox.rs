// The company's first data, from the platform (#711; deploy-api.md section
// 21): `POST /api/setup` (functions/api/setup.ts) once, with a one-time token
// (lib/setup-token.ts), when the owner creates the app from the dashboard or
// the platform's MCP tool. The demo seed is never loaded.
//
// Two steps, because `org` creates organisations and sends invitations only
// for a signed-in user, and the setup call has none:
//
// 1. `writeSetup` (the call, one transaction): the settings (brand name,
//    phone, TRN, emirate, and `setup_hash`, the deployment hash the token
//    names), the services, the owner's account (`auth.register`: its mail
//    carries the sign-in link) with the global role `owner`, and the branches
//    and people as `setup_pending`.
// 2. `finishSetup` (the owner's first page after signing in, lib/page.ts, one
//    transaction): one `org` organisation per branch with the owner as its
//    owner, the branch rows and their working hours, and the invitations of
//    the people through `org` (lib/admin.ts inviteStaff) to the first branch,
//    each with their app role. `setup_pending` is then removed.
import type { Authz, DbStatements } from "@renoxium/sdk";
import { audit, auth, org } from "renox:modules";

import { inviteStaff, STAFF_ROLES, type StaffRole } from "./admin";
import { DEFAULT_HOURS } from "./booking-sync";
import type { Branch } from "./scope";

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

/** The branches and people that wait for the owner's first sign-in (the setting `setup_pending`). */
interface Pending {
  branches: { name: string; emirate: string }[];
  people: { email: string; role: StaffRole }[];
}

interface SetupCtx {
  readonly db: DbStatements & { transaction<T>(fn: (tx: DbStatements) => Promise<T>): Promise<T> };
  readonly authz: Pick<Authz, "roles">;
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
 * Step 1, in one transaction: "taken" (409) when the app already holds its
 * setup or any user (a second call changes nothing); else the settings, the
 * services, the owner's account with the role `owner`, and the pending
 * branches and people.
 */
export async function writeSetup(ctx: SetupCtx, input: SetupInput, hash: string): Promise<SetupAnswer | "taken"> {
  return ctx.db.transaction(async (tx) => {
    const done = await tx.queryOne<{ n: number }>("select (select count(*) from app__settings where key = 'setup_hash') + (select count(*) from auth__public_users_v1) + (select count(*) from app__branches) as n", []);
    if ((done?.n ?? 0) > 0) return "taken";

    const skipped = input.people.filter((p) => p.email === input.owner.email).map((p) => ({ email: p.email, reason: "the owner" }));
    const people = input.people.filter((p) => p.email !== input.owner.email);
    const pending: Pending = { branches: input.branches, people };
    const settings: [string, string][] = [
      ["brand_name", input.company.name],
      ["company_phone", input.company.phone],
      ["company_trn", input.company.trn],
      ["company_emirate", input.company.emirate],
      ["setup_hash", hash],
      ["setup_owner_email", input.owner.email],
      ["setup_pending", JSON.stringify(pending)],
    ];
    for (const [key, value] of settings) await tx.execute("insert into app__settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", [key, value]);

    const codes = new Set((await tx.query<{ code: string }>("select code from app__services", [])).map((r) => r.code));
    for (const [i, s] of input.services.entries()) {
      await tx.execute("insert into app__services (branch_id, code, name_en, name_ar, unit, price_fils, vat_rate, active) values (null, ?, ?, ?, 'visit', ?, 5, 1)", [serviceCode(s.name, i, codes), s.name, s.name, Math.round(s.price_aed * 100)]);
    }

    // The owner signs in with the link of the confirmation mail (or a reset); nobody knows this password.
    const made = await auth.register({ email: input.owner.email, password: randomHex(32) });
    if ("error" in made) throw new Error(`auth.register: ${made.error}`);
    const owner = await tx.queryOne<{ id: string }>("select id from auth__public_users_v1 where email = ?", [input.owner.email]);
    if (owner === null) throw new Error("auth.register created no user");
    await ctx.authz.roles.assign(owner.id, "owner");
    await audit.record({ action: "setup.write", actor: { kind: "system", id: "platform" }, resource: { type: "Settings", id: "setup" }, details: { branches: input.branches.length, services: input.services.length, people: people.length } });
    return { invited: people.map((p) => ({ email: p.email, role: p.role })), skipped };
  });
}

interface FinishCtx {
  readonly db: DbStatements & { transaction<T>(fn: (tx: DbStatements) => Promise<T>): Promise<T> };
  readonly authz: Pick<Authz, "roles">;
  readonly principal: { readonly id: string } | null;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** A slug of letters and digits for a branch's organisation (`branch-<n>` without any). */
const slugOf = (name: string, i: number): string =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "") || `branch-${i + 1}`;

/**
 * Step 2, for the signed-in owner named by the setup, while it is pending:
 * the branches as `org` organisations and the invitations. True when it ran.
 * In a transaction of its own (a loader's request).
 */
export async function finishSetup(ctx: FinishCtx, user: { id: string; email: string }, settings: Record<string, string>): Promise<boolean> {
  if (settings.setup_pending === undefined || (settings.setup_owner_email ?? "") !== user.email.toLowerCase() || ctx.principal?.id !== user.id) return false;
  const run = async (tx: DbStatements): Promise<boolean> => {
    const row = await tx.queryOne<{ value: string }>("select value from app__settings where key = 'setup_pending'", []);
    if (row === null) return false;
    const pending = JSON.parse(row.value) as Pending;
    const made: Branch[] = [];
    for (const [i, b] of pending.branches.entries()) {
      const base = slugOf(b.name, i);
      let created: { id: string; slug: string } | undefined;
      for (let n = 1; created === undefined && n <= 20; n++) {
        const slug = n === 1 ? base : `${base}-${n}`;
        if ((await tx.queryOne("select 1 as x from app__branches where slug = ?", [slug])) !== null) continue;
        const r = await org.createOrg({ name: b.name, slug });
        if ("org" in r) created = r.org;
      }
      if (created === undefined) throw new Error(`setup: no free address for the branch ${b.name}`);
      const id = `br_${created.slug.replace(/-/gu, "_")}`;
      await tx.execute("insert into app__branches (id, org_id, name_en, name_ar, phone, address, emirate, area, slug, created_at) values (?, ?, ?, ?, '', '', ?, '', ?, ?)", [id, created.id, b.name, b.name, b.emirate, created.slug, now()]);
      for (const h of DEFAULT_HOURS) await tx.execute("insert into app__branch_hours (branch_id, weekday, open_min, close_min) values (?, ?, ?, ?)", [id, h.weekday, h.open_min, h.close_min]);
      made.push({ id, org_id: created.id, name_en: b.name, name_ar: b.name, slug: created.slug, emirate: b.emirate, area: "" });
    }
    const first = made[0];
    if (first !== undefined) {
      // The owner starts in the first branch, where the people are invited.
      await org.switchOrg(first.org_id);
      for (const p of pending.people) {
        // The transaction's own statements: a `db.scoped()` statement inside `db.transaction` answers
        // "database is busy" on the worker (0.7.1). The app's tables are never refused unscoped (D16),
        // and every row written here carries the first branch's id.
        const sent = await inviteStaff({ ...ctx, db: tx }, tx, first, p.email, p.role);
        if (!sent.ok) throw new Error(`setup: the invitation of a person failed (${sent.error})`);
      }
    }
    await tx.execute("delete from app__settings where key = 'setup_pending'", []);
    await tx.execute("insert into app__settings (key, value) values ('setup_finished_at', ?) on conflict (key) do update set value = excluded.value", [String(now())]);
    await audit.record({ action: "setup.finish", actor: { kind: "user", id: user.id }, resource: { type: "Settings", id: "setup" }, details: { branches: made.map((b) => b.id), invited: pending.people.length } });
    return true;
  };
  return ctx.db.transaction(run);
}
