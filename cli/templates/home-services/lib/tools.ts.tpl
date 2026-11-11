// The App MCP tools of the app (functions/tools): what an agent may ask of the
// app as the user whose token it holds. The tools do the work here, in plain
// functions the tests can also call, and share the pages' rules (lib/jobs.ts,
// lib/booking-sync.ts), so an agent never has a way the pages do not.
//
// A tool call has the token's user and NO session: `branchOf` (the session's
// active organisation) and the `org` services that answer for the signed-in
// session do not apply. The user's branches come from org's public view
// (org__public_members_v1); when more than one holds the user, the agent names
// the branch (its slug) and the call runs as if that branch were the active one.
import type { ActionContext, DbStatements, Principal, Realtime } from "@renoxium/sdk";

import { addDays } from "./contract-dates";
import { bookingService, clock, ensureSynced, slotsOn } from "./booking-sync";
import { listCustomers } from "./customers";
import { day as dayOf } from "./quotes";
import { type Branch, branchDb, type Scopable } from "./scope";
import { techniciansOf } from "./technicians";

export interface ToolCtx {
  readonly db: Scopable;
  readonly principal: Principal | null;
  readonly authz: ActionContext["authz"];
  readonly realtime: Pick<Realtime, "publish">;
}

/** An answer that is not an exception: the agent reads `error` and `message` and may try again. */
export type ToolError = { error: "not_found" | "forbidden" | "branch_required" | "bad_input" | "slot_unavailable" | "unavailable"; message: string; branches?: string[] };
export const refuse = (error: ToolError["error"], message: string, extra: Pick<ToolError, "branches"> = {}): ToolError => ({ error, message, ...extra });

/** The branches the user belongs to (org's public view of memberships), oldest first. */
export async function branchesOfUser(db: DbStatements, userId: string): Promise<Branch[]> {
  return db.query<Branch>("select b.id as id, b.org_id as org_id, b.name_en as name_en, b.name_ar as name_ar, b.slug as slug, b.emirate as emirate, b.area as area from app__branches b join org__public_members_v1 m on m.org_id = b.org_id where m.user_id = ? order by b.created_at, b.id", [userId]);
}

/** The branches a call may work in: the consent's organisation when the token carries one (see `pickBranch`), else every branch of the user. */
export async function branchesOfToken(db: DbStatements, me: Principal): Promise<Branch[]> {
  const all = await branchesOfUser(db, me.id);
  return typeof me.attrs.org === "string" ? all.filter((b) => b.org_id === me.attrs.org) : all;
}

/**
 * The branch a call works in. An agent token's principal carries the roles of
 * the organisation picked on the consent page (`principal.attrs.org`, #590),
 * and the policies decide the tool's action with those roles: so a token works
 * in that branch only, and naming another of the user's branches is unknown
 * (else a dispatcher of one branch who is a technician of another could create
 * jobs there). Without that attribute: the one named, else the user's only one.
 */
export async function pickBranch(ctx: Pick<ToolCtx, "db" | "principal">, wanted: string | undefined): Promise<{ branch: Branch } | ToolError> {
  const me = ctx.principal;
  if (me === null) return refuse("forbidden", "A signed-in user is required.");
  const mine = await branchesOfToken(ctx.db, me);
  if (mine.length === 0) return refuse("forbidden", "You belong to no branch.");
  if (wanted !== undefined) {
    const w = wanted.trim().toLowerCase();
    const hit = mine.find((b) => b.slug === w || b.id === w || b.name_en.toLowerCase() === w);
    // A branch the token does not act in is reported as unknown: the tool does not say which branches exist.
    return hit === undefined ? refuse("not_found", `No branch "${wanted}" among your branches.`, { branches: mine.map((b) => b.slug) }) : { branch: hit };
  }
  if (mine.length === 1) return { branch: mine[0] as Branch };
  return refuse("branch_required", "You belong to several branches: name one in `branch`.", { branches: mine.map((b) => b.slug) });
}

/** The ctx the page functions (lib/jobs.ts) take, with `branch` as the active organisation of the principal. */
export function inBranch(ctx: ToolCtx, branch: Branch): ToolCtx & { readonly principal: Principal } {
  const me = ctx.principal as Principal;
  return { db: ctx.db, authz: ctx.authz, realtime: ctx.realtime, principal: { ...me, attrs: { ...me.attrs, org: branch.org_id } } };
}

export const isToolError = (v: unknown): v is ToolError => typeof v === "object" && v !== null && "error" in v && "message" in v;

/** A catalogue service by code (`AC-SERVICE`) or English name, active, of the company or the branch. */
export async function findService(db: DbStatements, wanted: string, branchId: string): Promise<{ id: number; code: string; name_en: string } | null> {
  return db.queryOne("select id, code, name_en from app__services where active = 1 and (branch_id is null or branch_id = ?) and (lower(code) = lower(?) or lower(name_en) = lower(?)) order by id limit 1", [branchId, wanted, wanted]);
}

export interface FreeSlot {
  /** `<technician id>@<start in unix ms>`: what the slot picker posts and `create_job` takes. */
  slot: string;
  technician_id: string;
  technician: string;
  day: string;
  start: string;
  end: string;
}

const DAYS_AHEAD = 14;

/** The next `count` free slots of the service from `fromDay` (`YYYY-MM-DD`, default today in Dubai), earliest first, each with its technician, as the schedule picker offers them. */
export async function nextFreeSlots(ctx: ToolCtx, branch: Branch, serviceCode: string, fromDay: string | undefined, count = 3): Promise<FreeSlot[]> {
  const technicians = await techniciansOf(ctx, branch);
  if (technicians.length === 0) return [];
  await ensureSynced(ctx.db, branch, technicians, serviceCode);
  const names = new Map(technicians.map((t) => [t.id, t.name]));
  const staff = technicians.map((t) => t.id);
  const start = fromDay ?? dayOf(Math.floor(Date.now() / 1000));
  const out: FreeSlot[] = [];
  for (let i = 0; i < DAYS_AHEAD && out.length < count; i++) {
    const key = addDays(start, i);
    for (const s of await slotsOn(bookingService(serviceCode), key, staff)) {
      if (s.start < Date.now()) continue;
      out.push({ slot: `${s.staff}@${s.start}`, technician_id: s.staff, technician: names.get(s.staff) ?? s.staff, day: key, start: `${key} ${clock(Math.floor(s.start / 1000))}`, end: `${key} ${clock(Math.floor(s.end / 1000))}` });
      if (out.length === count) break;
    }
  }
  return out;
}

/** The customer of the branch whose stored phone matches `phone` (digits compared without the country prefix). */
export async function customerByPhone(sdb: DbStatements, phone: string): Promise<{ id: string; name: string } | "none" | "several"> {
  const digits = (p: string): string => p.replace(/\D/gu, "").replace(/^(00971|971|0)/u, "");
  const want = digits(phone);
  if (want.length < 7) return "none";
  const found = (await listCustomers(sdb, phone)).filter((c) => digits(c.phone) === want);
  return found.length === 0 ? "none" : found.length > 1 ? "several" : { id: (found[0] as { id: string }).id, name: (found[0] as { name: string }).name };
}

/** `db` fenced to the branch (the tools' reads of owned tables). */
export const fenced = (db: Scopable, branch: Branch): DbStatements => branchDb(db, branch.id);
