// Annual maintenance contracts (AMC): a contract lists services at sites with a
// visit frequency. The daily job jobs/amc-visits.ts turns each item's next due
// day into a `new` job (`generateVisits`), jobs/amc-renewals.ts reminds the
// customer 30 days before the end and expires the contract the day after it
// (`remindRenewals`). Activating a draft issues the upfront tax invoice through
// the `tax_gcc` module (`activate`).
//
// Everything of the branch goes through the branch-scoped Db of lib/scope.ts.
// The two scheduled functions run as the system principal: they read across
// branches, then write each branch's rows through `branchDb` (`db.scoped`).
//
// A module service that throws inside the caller's transaction rolls it back,
// so what can fail (the checks, then the module's invoice) comes before the
// first write of `activate`.
import type { DbStatements } from "@renoxium/sdk";
import { audit, tax_gcc } from "renox:modules";

import { addDays, nextVisit, RENEWAL_NOTICE_DAYS, VISIT_AHEAD_DAYS, yearEnd } from "./contract-dates";
import type { ContractInput, ItemInput } from "./contract-forms";
import { findCustomer } from "./customers";
import { insertJob, type JobCtx } from "./jobs";
import { type Outcome, TERMS_DAYS, INVOICE_LINK_SECONDS, type TaxDocument } from "./invoices";
import { issueLink } from "./links";
import { aed } from "./money";
import { notifyCustomer } from "./notify";
import { day } from "./quotes";
import { branchDb, branchOf, findBranch, scopedDb } from "./scope";

export const STATUSES = ["draft", "active", "expired", "cancelled"] as const;
export type ContractStatus = (typeof STATUSES)[number];

export type ContractRow = {
  id: string;
  branch_id: string;
  customer_id: string;
  number: string;
  status: ContractStatus;
  starts_on: string;
  ends_on: string;
  price_fils: number;
  vat_rate: number;
  billing: "upfront";
  notes: string;
  invoice_id: string | null;
  renewed_from: string | null;
  renewal_notified_on: string | null;
  created_by: string;
  created_at: number;
  activated_at: number | null;
};

export type ItemRow = { id: number; contract_id: string; branch_id: string; site_id: string; service_id: number; visits_per_year: number; next_visit_on: string };

const COLUMNS = "id, branch_id, customer_id, number, status, starts_on, ends_on, price_fils, vat_rate, billing, notes, invoice_id, renewed_from, renewal_notified_on, created_by, created_at, activated_at";
const ITEM_COLUMNS = "id, contract_id, branch_id, site_id, service_id, visits_per_year, next_visit_on";

const now = (): number => Math.floor(Date.now() / 1000);
const newId = (): string => `ct_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;

/** A contract id from a URL or a form: plain characters only; anything else is no contract. */
export const contractId = (raw: unknown): string | null => (typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(raw) ? raw : null);

/** The Dubai day today. */
export const today = (): string => day(now());

const fail = (status: 403 | 404 | 409 | 422, message: string): { ok: false; status: 403 | 404 | 409 | 422; message: string } => ({ ok: false, status, message });

/** A contract of the branch, or null: another branch's is not found. */
export async function findContract(sdb: DbStatements, id: unknown): Promise<ContractRow | null> {
  const key = contractId(id);
  return key === null ? null : sdb.queryOne<ContractRow>(`select ${COLUMNS} from app__contracts where id = ?`, [key]);
}

export type ContractListRow = ContractRow & { customer_name: string; items: number };

/** The branch's contracts, newest first, optionally of one status. */
export async function listContracts(sdb: DbStatements, status: string): Promise<ContractListRow[]> {
  const rows = await sdb.query<Omit<ContractListRow, "items">>(
    `select c.id, c.branch_id, c.customer_id, c.number, c.status, c.starts_on, c.ends_on, c.price_fils, c.vat_rate, c.billing, c.notes, c.invoice_id, c.renewed_from, c.renewal_notified_on, c.created_by, c.created_at, c.activated_at, cu.name as customer_name
     from app__contracts c join app__customers cu on cu.id = c.customer_id where (?1 = '' or c.status = ?1) order by c.created_at desc, c.number desc limit 300`,
    [status],
  );
  const counts = await sdb.query<{ contract_id: string; n: number }>("select contract_id, count(*) as n from app__contract_items group by contract_id", []);
  const byContract = new Map(counts.map((c) => [c.contract_id, c.n]));
  return rows.map((r) => ({ ...r, items: byContract.get(r.id) ?? 0 }));
}

export async function itemsOf(sdb: DbStatements, contract: string): Promise<ItemRow[]> {
  return sdb.query<ItemRow>(`select ${ITEM_COLUMNS} from app__contract_items where contract_id = ? order by id`, [contract]);
}

export type VisitRow = { job_id: string; number: string; status: string; due_on: string; service_id: number; site_id: string };

/** The jobs made for the contract, by due day. */
export async function visitsOf(sdb: DbStatements, contract: string): Promise<VisitRow[]> {
  return sdb.query<VisitRow>(
    "select j.id as job_id, j.number, j.status, cj.due_on, j.service_id, j.site_id from app__contract_jobs cj join app__jobs j on j.id = cj.job_id where cj.contract_id = ? order by cj.due_on, j.number",
    [contract],
  );
}

/** The site of the customer and the service of the catalogue an item names, or the reason it is wrong. */
async function checkItem(ctx: { db: DbStatements }, sdb: DbStatements, branchId: string, customerId: string, item: ItemInput): Promise<string | null> {
  const site = await sdb.queryOne<{ customer_id: string }>("select customer_id from app__sites where id = ?", [item.site_id]);
  if (site === null || site.customer_id !== customerId) return "Choose a site of this customer.";
  const service = await ctx.db.queryOne<{ id: number }>("select id from app__services where id = ? and active = 1 and (branch_id is null or branch_id = ?)", [item.service_id, branchId]);
  return service === null ? "Unknown service." : null;
}

async function insertItem(sdb: DbStatements, branchId: string, contract: string, startsOn: string, item: ItemInput): Promise<void> {
  await sdb.execute("insert into app__contract_items (contract_id, branch_id, site_id, service_id, visits_per_year, next_visit_on) values (?, ?, ?, ?, ?, ?)", [
    contract,
    branchId,
    item.site_id,
    item.service_id,
    item.visits_per_year,
    startsOn,
  ]);
}

/** What the actions of this file need of the ctx. */
type Ctx = Pick<JobCtx, "db" | "principal">;

/** Writes a draft contract (the next AMC number) with its items. 422 for a customer, site or service that is not of this branch. */
export async function createContract(ctx: Ctx, input: ContractInput, renewedFrom: string | null = null): Promise<Outcome<ContractRow>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const userId = ctx.principal?.id;
  if (userId === undefined) return fail(403, "Forbidden");
  const sdb = scopedDb(ctx.db, branch);
  const customer = await findCustomer(sdb, input.customer_id);
  if (customer === null) return fail(422, "Choose a customer of this branch.");
  for (const item of input.items) {
    const bad = await checkItem(ctx, sdb, branch.id, customer.id, item);
    if (bad !== null) return fail(422, bad);
  }
  const endsOn = input.ends_on ?? yearEnd(input.starts_on);
  if (endsOn < input.starts_on) return fail(422, "The contract cannot end before it starts.");
  const id = newId();
  const n = await ctx.db.execute("insert into app__contract_numbers (contract_id) values (?)", [id]);
  const number = `AMC-${String(Number(n.lastInsertRowid)).padStart(6, "0")}`;
  await sdb.execute(
    "insert into app__contracts (id, branch_id, customer_id, number, status, starts_on, ends_on, price_fils, vat_rate, billing, notes, renewed_from, created_by, created_at) values (?, ?, ?, ?, 'draft', ?, ?, ?, 5, 'upfront', ?, ?, ?, ?)",
    [id, branch.id, customer.id, number, input.starts_on, endsOn, input.price_fils, input.notes, renewedFrom, userId, now()],
  );
  for (const item of input.items) await insertItem(sdb, branch.id, id, input.starts_on, item);
  await audit.record({ action: "contract.create", actor: { kind: "user", id: userId }, resource: { type: "Contract", id }, details: { number, customer: customer.id, items: input.items.length } });
  return { ok: true, value: (await findContract(sdb, id)) as ContractRow };
}

/** Adds an item to a draft contract (the first visit falls due on its start). */
export async function addItem(ctx: Ctx, rawId: unknown, item: ItemInput): Promise<Outcome<ItemRow[]>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const contract = await findContract(sdb, rawId);
  if (contract === null) return fail(404, "Contract not found");
  if (contract.status !== "draft") return fail(409, `${contract.number} is ${contract.status}: only a draft takes new items.`);
  const bad = await checkItem(ctx, sdb, branch.id, contract.customer_id, item);
  if (bad !== null) return fail(422, bad);
  await insertItem(sdb, branch.id, contract.id, contract.starts_on, item);
  return { ok: true, value: await itemsOf(sdb, contract.id) };
}

/** Removes an item from a draft contract. */
export async function removeItem(ctx: Ctx, rawId: unknown, itemId: number): Promise<Outcome<ItemRow[]>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const contract = await findContract(sdb, rawId);
  if (contract === null) return fail(404, "Contract not found");
  if (contract.status !== "draft") return fail(409, `${contract.number} is ${contract.status}: only a draft loses items.`);
  const gone = await sdb.execute("delete from app__contract_items where id = ? and contract_id = ?", [itemId, contract.id]);
  if (gone.changes !== 1) return fail(404, "Item not found");
  return { ok: true, value: await itemsOf(sdb, contract.id) };
}

/** The checks of an activation: a draft of this branch with at least one item. */
export async function readyToActivate(ctx: Ctx, rawId: unknown): Promise<Outcome<ContractRow>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const contract = await findContract(sdb, rawId);
  if (contract === null) return fail(404, "Contract not found");
  if (contract.status !== "draft") return fail(409, `${contract.number} is ${contract.status}, not a draft.`);
  if ((await itemsOf(sdb, contract.id)).length === 0) return fail(422, "Add at least one service and site before activating.");
  return { ok: true, value: contract };
}

export interface Activated {
  contract: ContractRow;
  /** The upfront invoice's number; null for a contract with no price. */
  invoice: string | null;
  /** The customer's link to it, a path (`/l/invoice/<token>`): shown once. */
  link: string | null;
}

const lineText = (c: ContractRow, language: "en" | "ar"): string =>
  language === "ar" ? `عقد صيانة سنوي ${c.number} (من ${c.starts_on} إلى ${c.ends_on})` : `Annual maintenance contract ${c.number} (${c.starts_on} to ${c.ends_on})`;

/**
 * Activates a draft: `upfront` billing issues one tax invoice for the yearly
 * price through the module (the 5 % VAT is the module's), keeps it in
 * app__job_invoices with the contract in place of a job, and tells the
 * customer. A contract with no price issues none. The visits are made by the
 * daily job, not here. Who may issue the invoice (a sensitive action) is the
 * caller's to check.
 */
export async function activate(ctx: Ctx & { readonly url?: URL }, rawId: unknown): Promise<Outcome<Activated>> {
  const ready = await readyToActivate(ctx, rawId);
  if (!ready.ok) return ready;
  const contract = ready.value;
  const branch = (await branchOf(ctx)) as NonNullable<Awaited<ReturnType<typeof branchOf>>>;
  const sdb = scopedDb(ctx.db, branch);
  const customer = await findCustomer(sdb, contract.customer_id);
  if (customer === null) return fail(404, "Customer not found");
  const by = ctx.principal?.id ?? "unknown";
  let invoice: string | null = null;
  let link: string | null = null;
  let total = 0;
  if (contract.price_fils > 0) {
    const site = await sdb.queryOne<{ label: string; area: string; address: string }>(
      "select s.label, s.area, s.address from app__contract_items i join app__sites s on s.id = i.site_id where i.contract_id = ? order by i.id limit 1",
      [contract.id],
    );
    // The module throws on a bad line or a missing seller TRN: that rolls the action back, so nothing is half done.
    const doc = (await tax_gcc.issue({
      buyer: { name: customer.name, ...(customer.trn === null ? {} : { trn: customer.trn }), address: site === null ? "" : `${site.label}, ${site.area}, ${site.address}` },
      lines: [{ description: lineText(contract, customer.language), quantity: 1, unit_fils: contract.price_fils, rate: "standard" }],
    })) as TaxDocument;
    invoice = doc.number;
    total = doc.totals.total;
    const t = now();
    await sdb.execute("insert into app__job_invoices (job_id, contract_id, branch_id, customer_id, invoice_id, total_fils, due_at, created_by, created_at) values (null, ?, ?, ?, ?, ?, ?, ?, ?)", [
      contract.id,
      branch.id,
      customer.id,
      doc.number,
      doc.totals.total,
      t + TERMS_DAYS * 86400,
      by,
      t,
    ]);
    await audit.record({ action: "invoice.issue", actor: { kind: "user", id: by }, resource: { type: "Invoice", id: doc.number }, details: { contract: contract.number, total_fils: doc.totals.total } });
    link = await issueLink(ctx, "invoice", doc.number, INVOICE_LINK_SECONDS);
  }
  const won = await sdb.execute("update app__contracts set status = 'active', activated_at = ?, invoice_id = ? where id = ? and status = 'draft'", [now(), invoice, contract.id]);
  if (won.changes !== 1) throw new Error(`contract ${contract.number} changed while it was activated`);
  await audit.record({ action: "contract.activate", actor: { kind: "user", id: by }, resource: { type: "Contract", id: contract.id }, details: { number: contract.number, invoice } });
  if (invoice !== null && link !== null) {
    await notifyCustomer(ctx, customer, "invoice_due", { branch_id: branch.id, ref_id: invoice, customer_link: link, vars: { number: invoice, amount: `AED ${aed(total)}` } });
  }
  return { ok: true, value: { contract: (await findContract(sdb, contract.id)) as ContractRow, invoice, link } };
}

/** Cancels a draft or an active contract; the visits already made stay. */
export async function cancelContract(ctx: Ctx, rawId: unknown): Promise<Outcome<ContractRow>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const contract = await findContract(sdb, rawId);
  if (contract === null) return fail(404, "Contract not found");
  if (contract.status !== "draft" && contract.status !== "active") return fail(409, `${contract.number} is ${contract.status} and cannot be cancelled.`);
  const won = await sdb.execute("update app__contracts set status = 'cancelled' where id = ? and status = ?", [contract.id, contract.status]);
  if (won.changes !== 1) return fail(409, "The contract changed meanwhile; reload it.");
  await audit.record({ action: "contract.cancel", actor: { kind: "user", id: ctx.principal?.id ?? "unknown" }, resource: { type: "Contract", id: contract.id }, details: { number: contract.number, was: contract.status } });
  return { ok: true, value: (await findContract(sdb, contract.id)) as ContractRow };
}

/**
 * The next year: a new draft with the same customer, price, notes and items,
 * starting the day after this one ends. An active or expired contract is
 * renewed once (409 for a second time, or for a draft or a cancelled one).
 */
export async function renewContract(ctx: Ctx, rawId: unknown): Promise<Outcome<ContractRow>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const contract = await findContract(sdb, rawId);
  if (contract === null) return fail(404, "Contract not found");
  if (contract.status !== "active" && contract.status !== "expired") return fail(409, `${contract.number} is ${contract.status}: only an active or expired contract is renewed.`);
  const done = await sdb.queryOne<{ number: string }>("select number from app__contracts where renewed_from = ? and status != 'cancelled'", [contract.id]);
  if (done !== null) return fail(409, `${contract.number} was renewed already (${done.number}).`);
  const items = (await itemsOf(sdb, contract.id)).map((i) => ({ site_id: i.site_id, service_id: i.service_id, visits_per_year: i.visits_per_year }));
  const startsOn = addDays(contract.ends_on, 1);
  return createContract(ctx, { customer_id: contract.customer_id, starts_on: startsOn, ends_on: yearEnd(startsOn), price_fils: contract.price_fils, notes: contract.notes, items }, contract.id);
}

/** What the scheduled functions need of the job's ctx: no request, no principal worth the name. */
export type JobWorkCtx = Pick<JobCtx, "db" | "principal" | "realtime">;

type DueItem = ItemRow & { number: string; starts_on: string; ends_on: string; created_by: string };

export interface VisitsResult {
  jobs: number;
}

/**
 * The visits job: for every item of an active contract whose next visit falls
 * due within fourteen days (and not after the contract ends), a `new` job for
 * its service and site, linked in app__contract_jobs; then `next_visit_on`
 * moves on to the next visit day (365 / visits_per_year days later,
 * lib/contract-dates.ts). A visit that is overdue (the job did not run for a
 * while) becomes one job due today, not one per missed day. The
 * job of an (item, day) is made once: a second run, or a retry, makes none.
 */
export async function generateVisits(ctx: JobWorkCtx, from = today()): Promise<VisitsResult> {
  const horizon = addDays(from, VISIT_AHEAD_DAYS);
  const due = await ctx.db.query<DueItem>(
    `select i.id, i.contract_id, i.branch_id, i.site_id, i.service_id, i.visits_per_year, i.next_visit_on, c.number, c.starts_on, c.ends_on, c.created_by
     from app__contract_items i join app__contracts c on c.id = i.contract_id
     where c.status = 'active' and i.next_visit_on <= ?1 and i.next_visit_on <= c.ends_on order by i.next_visit_on, i.id`,
    [horizon],
  );
  const result: VisitsResult = { jobs: 0 };
  for (const item of due) {
    const branch = await findBranch(ctx.db, item.branch_id);
    if (branch === null) continue;
    const sdb = branchDb(ctx.db, branch.id);
    const site = await sdb.queryOne<{ id: string; customer_id: string }>("select id, customer_id from app__sites where id = ?", [item.site_id]);
    if (site === null) continue;
    let dueOn = item.next_visit_on < from ? from : item.next_visit_on;
    while (dueOn <= horizon && dueOn <= item.ends_on) {
      const made = await ctx.db.queryOne<{ job_id: string }>("select job_id from app__contract_jobs where item_id = ? and due_on = ?", [item.id, dueOn]);
      if (made === null) {
        const r = await insertJob(ctx, branch, sdb, {
          site,
          serviceId: item.service_id,
          quoteId: null,
          priority: "normal",
          description: `Annual maintenance contract ${item.number}: visit due ${dueOn}`,
          by: item.created_by,
          note: `created for contract ${item.number}, visit due ${dueOn}`,
          source: "contract",
        });
        await sdb.execute("insert into app__contract_jobs (contract_id, branch_id, item_id, job_id, due_on, created_at) values (?, ?, ?, ?, ?, ?)", [item.contract_id, item.branch_id, item.id, r.job.id, dueOn, now()]);
        result.jobs += 1;
      }
      dueOn = nextVisit(item.starts_on, dueOn, item.visits_per_year);
    }
    await sdb.execute("update app__contract_items set next_visit_on = ? where id = ?", [dueOn, item.id]);
  }
  return result;
}

export interface RenewalsResult {
  reminded: number;
  expired: number;
}

/**
 * The renewals job: a contract that ends in exactly thirty days gets one
 * reminder (the customer by `amc_renewal`, and the staff member who made the
 * contract in the app; `renewal_notified_on` keeps a second run from repeating
 * it); then an active contract whose last day was yesterday or earlier becomes
 * `expired`. The staff member is the contract's creator: a scheduled run has no
 * request to pick a dispatcher from.
 */
export async function remindRenewals(ctx: JobWorkCtx, from = today()): Promise<RenewalsResult> {
  const result: RenewalsResult = { reminded: 0, expired: 0 };
  const due = await ctx.db.query<ContractRow>(
    "select id, branch_id, customer_id, number, status, starts_on, ends_on, price_fils, vat_rate, billing, notes, invoice_id, renewed_from, renewal_notified_on, created_by, created_at, activated_at from app__contracts where status = 'active' and ends_on = ? and renewal_notified_on is null order by number",
    [addDays(from, RENEWAL_NOTICE_DAYS)],
  );
  for (const c of due) {
    const marked = await branchDb(ctx.db, c.branch_id).execute("update app__contracts set renewal_notified_on = ? where id = ? and renewal_notified_on is null", [from, c.id]);
    if (marked.changes !== 1) continue;
    await notifyCustomer(ctx, { id: c.customer_id }, "amc_renewal", {
      branch_id: c.branch_id,
      ref_id: c.id,
      staff_user: c.created_by,
      staff_category: "contracts",
      title: `Contract ${c.number} ends on ${c.ends_on}`,
      link: `/contracts/${c.id}`,
      vars: { number: c.number, ends: c.ends_on },
    });
    await audit.record({ action: "contract.renewal_reminder", actor: { kind: "system", id: "amc-renewals" }, resource: { type: "Contract", id: c.id }, details: { number: c.number, ends_on: c.ends_on } });
    result.reminded += 1;
  }
  const gone = await ctx.db.query<{ id: string; number: string; branch_id: string }>("select id, number, branch_id from app__contracts where status = 'active' and ends_on < ? order by number", [from]);
  for (const c of gone) {
    const won = await branchDb(ctx.db, c.branch_id).execute("update app__contracts set status = 'expired' where id = ? and status = 'active'", [c.id]);
    if (won.changes !== 1) continue;
    await audit.record({ action: "contract.expire", actor: { kind: "system", id: "amc-renewals" }, resource: { type: "Contract", id: c.id }, details: { number: c.number } });
    result.expired += 1;
  }
  return result;
}
