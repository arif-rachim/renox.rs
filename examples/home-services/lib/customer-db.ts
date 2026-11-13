// The customer portal's data (#774): what a portal user (lib/portal.ts) may
// read, and nothing else. A portal user is tied to one customer row per branch
// (the same phone); every statement here runs on the branch's fenced database
// (lib/scope.ts branchDb) AND names the customer, so a row of another customer
// is out of reach even in the same branch. `/my` loaders and actions read
// through `customerDb` only, never `ctx.db` or `branchDb` directly.
//
// This file imports no module (`renox:modules`), so the tests can run
// `customerDb` on the test app's database file.
import type { DbStatements, Row } from "@renoxium/sdk";

import type { InvoiceRow } from "./invoices";

import { branchDb, type Scopable } from "./scope";

/** One customer row the portal user is linked to: its id and its branch. */
export interface PortalCustomer {
  readonly id: string;
  readonly branch_id: string;
}

/** What customerDb needs of a portal user. */
export interface PortalScope {
  readonly user_id: string;
  readonly customers: readonly PortalCustomer[];
}

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * Links the user to every customer row with their phone (in every branch)
 * that is not linked yet, and records the link once (app__customer_users).
 * Runs on each sign-in check, so a customer row created since is linked too.
 * Returns the customer rows linked to the user, oldest first.
 */
export async function linkCustomers(db: Scopable, userId: string, phone: string): Promise<PortalCustomer[]> {
  await db.execute("insert or ignore into app__customer_users (user_id, phone, created_at) values (?, ?, ?)", [userId, phone, now()]);
  const branches = await db.query<{ id: string }>("select id from app__branches order by id", []);
  const out: { id: string; branch_id: string; created_at: number }[] = [];
  for (const b of branches) {
    const sdb = branchDb(db, b.id);
    await sdb.execute("update app__customers set user_id = ? where phone = ? and user_id is null", [userId, phone]);
    out.push(...(await sdb.query<{ id: string; branch_id: string; created_at: number }>("select id, branch_id, created_at from app__customers where user_id = ?", [userId])));
  }
  return out.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)).map((r) => ({ id: r.id, branch_id: r.branch_id }));
}

export interface CustomerDb {
  /** The ids of the user's customer rows. */
  readonly customer_ids: readonly string[];
  /** The user's customer rows. */
  customers(): Promise<Row[]>;
  /** Their sites. */
  sites(): Promise<Row[]>;
  /** Their jobs, newest first. */
  jobs(): Promise<Row[]>;
  /** One of their jobs, or null (another customer's job is null too). */
  job(id: string): Promise<Row | null>;
  /** The visits of their jobs, newest first. */
  visits(): Promise<Row[]>;
  /** Their invoices (app__job_invoices), newest first. */
  invoices(): Promise<Row[]>;
  /** One of their invoices by its number, or null. */
  invoice(invoiceId: string): Promise<Row | null>;
  /** The payments of one of their invoices; empty for another customer's. */
  payments(invoiceId: string): Promise<Row[]>;
  /** Their maintenance contracts, newest first. */
  contracts(): Promise<Row[]>;
  /** One of their contracts, or null. */
  contract(id: string): Promise<Row | null>;
  /** One of their jobs by its number (J-000123), or null. */
  jobByNumber(number: string): Promise<Row | null>;
  /**
   * The timeline of one of their jobs (#776): when, and from which status to which. The note and its
   * author are staff-only and not read. Empty for another customer's job.
   */
  jobEvents(jobId: string): Promise<Row[]>;
  /** The items of one of their contracts (site, service, visits per year, next visit); empty for another's. */
  contractItems(contractId: string): Promise<Row[]>;
  /** The visits made for one of their contracts (job id and due day); empty for another's. */
  contractJobs(contractId: string): Promise<Row[]>;
  /** The branches of their customer rows: id, the name in both languages and the phone. */
  branches(): Promise<Row[]>;
  /** The names of the catalogue's services (company-wide rows, no customer's data): id, name_en, name_ar. */
  services(): Promise<Row[]>;
  /**
   * The first name of the technician of one of their jobs: the first word of the member's display name,
   * never the rest of it or their phone; "" when no technician is set or the job is another customer's.
   */
  technicianFirstName(jobId: string): Promise<string>;
  /**
   * The state of their invoices (#777), newest first: the view app__invoice_status (paid so far and the
   * status) on each customer's branch, with `branch_id` and `customer_id` bound.
   */
  invoiceStates(): Promise<InvoiceRow[]>;
  /** The state of one of their invoices by its number, or null (another customer's, or no such invoice). */
  invoiceState(invoiceId: string): Promise<InvoiceRow | null>;
  /**
   * The visit of one of their jobs (#777): when, the summary in both languages and who signed. The
   * technician's notes, the GPS position and the storage keys are not read. Null for another customer's job.
   */
  visitOfJob(jobId: string): Promise<Row | null>;
  /** The parts used on the visit of one of their jobs: what and how many, never the price. Empty for another's. */
  visitParts(jobId: string): Promise<Row[]>;
  /** The photos of the visit of one of their jobs, in the order taken (id): phase, caption, key and size. Empty for another's. */
  visitPhotos(jobId: string): Promise<Row[]>;
  /** The company's payment instructions (app__settings, company-wide): the English and the Arabic text, "" when unset. */
  paymentInstructions(): Promise<{ en: string; ar: string }>;
}

/** The first word of a display name ("Ali Hassan" → "Ali"). */
export const firstName = (displayName: string): string => displayName.trim().split(/\s+/u)[0] ?? "";

/**
 * `db` restricted to the portal user's customers: each statement runs once
 * per linked customer, on that customer's branch (`branchDb`) and with
 * `customer_id = ?` bound to it. There is no statement without a customer.
 */
export function customerDb(db: Scopable, portal: PortalScope): CustomerDb {
  const fenced: { sdb: DbStatements; id: string; branch_id: string }[] = portal.customers.map((c) => ({ sdb: branchDb(db, c.branch_id), id: c.id, branch_id: c.branch_id }));
  /**
   * `sql` once per customer, `?1` bound to the customer's id and the others after it; the rows of all. Statements of
   * an owned table stay single-table (the fence adds its own predicate), so a table without `customer_id` is read
   * through `each`.
   */
  const all = async (sql: string, params: (string | number)[] = []): Promise<Row[]> => {
    const out: Row[] = [];
    for (const f of fenced) out.push(...(await f.sdb.query(sql, [f.id, ...params])));
    return out;
  };
  /** `then(sdb, id)` once per customer, on its branch's fenced database; the rows of all. */
  const each = async (then: (sdb: DbStatements, customerId: string) => Promise<Row[]>): Promise<Row[]> => {
    const out: Row[] = [];
    for (const f of fenced) out.push(...(await then(f.sdb, f.id)));
    return out;
  };
  const first = async (sql: string, params: (string | number)[]): Promise<Row | null> => (await all(sql, params))[0] ?? null;
  const newest = (key: string) => (rows: Row[]): Row[] => rows.sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0));
  return {
    customer_ids: portal.customers.map((c) => c.id),
    customers: () => all("select id, branch_id, kind, name, phone, email, language, created_at from app__customers where id = ?1"),
    sites: () => all("select * from app__sites where customer_id = ?1 order by label, id"),
    jobs: async () => newest("created_at")(await all("select * from app__jobs where customer_id = ?1")),
    job: (id) => first("select * from app__jobs where customer_id = ?1 and id = ?2", [id]),
    // Visits carry no customer_id: the customer's jobs name them (both tables fenced to the branch).
    visits: async () =>
      newest("checkin_at")(
        await each(async (sdb, id) => {
          const jobs = (await sdb.query<{ id: string }>("select id from app__jobs where customer_id = ?", [id])).map((j) => j.id);
          if (jobs.length === 0) return [];
          return sdb.query(`select * from app__visits where job_id in (${jobs.map(() => "?").join(", ")})`, jobs);
        }),
      ),
    invoices: async () => newest("created_at")(await all("select * from app__job_invoices where customer_id = ?1")),
    invoice: (invoiceId) => first("select * from app__job_invoices where customer_id = ?1 and invoice_id = ?2", [invoiceId]),
    payments: (invoiceId) =>
      each(async (sdb, id) => {
        const mine = await sdb.queryOne("select invoice_id from app__job_invoices where customer_id = ? and invoice_id = ?", [id, invoiceId]);
        return mine === null ? [] : sdb.query("select * from app__payments where invoice_id = ? order by received_at, id", [invoiceId]);
      }),
    contracts: async () => newest("created_at")(await all("select * from app__contracts where customer_id = ?1")),
    contract: (id) => first("select * from app__contracts where customer_id = ?1 and id = ?2", [id]),
    jobByNumber: (number) => first("select * from app__jobs where customer_id = ?1 and number = ?2", [number]),
    // Events, items and contract jobs carry no customer_id: the customer's job or contract is checked first, on the same branch.
    jobEvents: (jobId) =>
      each(async (sdb, id) =>
        (await sdb.queryOne("select id from app__jobs where customer_id = ? and id = ?", [id, jobId])) === null
          ? []
          : sdb.query("select id, at, from_status, to_status from app__job_events where job_id = ? order by at, id", [jobId]),
      ),
    contractItems: (contractId) =>
      each(async (sdb, id) =>
        (await sdb.queryOne("select id from app__contracts where customer_id = ? and id = ?", [id, contractId])) === null
          ? []
          : sdb.query("select id, site_id, service_id, visits_per_year, next_visit_on from app__contract_items where contract_id = ? order by id", [contractId]),
      ),
    contractJobs: (contractId) =>
      each(async (sdb, id) =>
        (await sdb.queryOne("select id from app__contracts where customer_id = ? and id = ?", [id, contractId])) === null
          ? []
          : sdb.query("select job_id, due_on from app__contract_jobs where contract_id = ? order by due_on, job_id", [contractId]),
      ),
    // app__branches and app__services are not owned (company-wide rows): only the customer's own branches are read.
    branches: async () => {
      const out: Row[] = [];
      for (const branchId of [...new Set(fenced.map((f) => f.branch_id))]) {
        const b = await db.queryOne("select id, name_en, name_ar, phone from app__branches where id = ?", [branchId]);
        if (b !== null) out.push(b);
      }
      return out;
    },
    services: () => db.query("select id, name_en, name_ar from app__services order by id"),
    technicianFirstName: async (jobId) => {
      for (const f of fenced) {
        const job = await f.sdb.queryOne<{ technician_user_id: string | null }>("select technician_user_id from app__jobs where customer_id = ? and id = ?", [f.id, jobId]);
        if (job === null) continue;
        if (job.technician_user_id === null) return "";
        const branch = await db.queryOne<{ org_id: string }>("select org_id from app__branches where id = ?", [f.branch_id]);
        if (branch === null) return "";
        // A member of the job's branch only (the public views of org and auth, as lib/technicians.ts reads them).
        const member = await db.queryOne("select user_id from org__public_members_v1 where org_id = ? and user_id = ?", [branch.org_id, job.technician_user_id]);
        if (member === null) return "";
        const user = await db.queryOne<{ display_name: string | null }>("select display_name from auth__public_users_v1 where id = ?", [job.technician_user_id]);
        return firstName(user?.display_name ?? "");
      }
      return "";
    },
    // The view is not ownable: each statement names the branch and the customer itself, on the fenced database.
    invoiceStates: async () => {
      const out: InvoiceRow[] = [];
      for (const f of fenced) out.push(...(await f.sdb.query<InvoiceRow>(`select ${INVOICE_STATE} from app__invoice_status where branch_id = ? and customer_id = ?`, [f.branch_id, f.id])));
      return out.sort((a, b) => b.created_at - a.created_at || b.invoice_id.localeCompare(a.invoice_id));
    },
    invoiceState: async (invoiceId) => {
      for (const f of fenced) {
        const row = await f.sdb.queryOne<InvoiceRow>(`select ${INVOICE_STATE} from app__invoice_status where branch_id = ? and customer_id = ? and invoice_id = ?`, [f.branch_id, f.id, invoiceId]);
        if (row !== null) return row;
      }
      return null;
    },
    // Visits, parts and photos carry no customer_id: the customer's job is checked first, on the same branch.
    visitOfJob: async (jobId) => (await each(async (sdb, id) => ((await mine(sdb, id, jobId)) ? sdb.query(`select ${VISIT_PUBLIC} from app__visits where job_id = ?`, [jobId]) : [])))[0] ?? null,
    visitParts: (jobId) =>
      each(async (sdb, id) => {
        const visit = (await mine(sdb, id, jobId)) ? await sdb.queryOne<{ id: string }>("select id from app__visits where job_id = ?", [jobId]) : null;
        return visit === null ? [] : sdb.query("select id, description, qty from app__visit_parts where visit_id = ? order by id", [visit.id]);
      }),
    visitPhotos: (jobId) =>
      each(async (sdb, id) => {
        const visit = (await mine(sdb, id, jobId)) ? await sdb.queryOne<{ id: string }>("select id from app__visits where job_id = ?", [jobId]) : null;
        return visit === null ? [] : sdb.query("select id, phase, file_key, caption, width, height from app__visit_photos where visit_id = ? order by id", [visit.id]);
      }),
    paymentInstructions: async () => {
      const rows = await db.query<{ key: string; value: string }>("select key, value from app__settings where key in ('payment_instructions_en', 'payment_instructions_ar')", []);
      const of = (key: string) => rows.find((r) => r.key === key)?.value ?? "";
      return { en: of("payment_instructions_en"), ar: of("payment_instructions_ar") };
    },
  };
}

const INVOICE_STATE = "invoice_id, job_id, branch_id, customer_id, total_fils, due_at, credit_note_id, created_at, paid_fils, status";
/** The columns of a visit the customer may see (#777): not the technician's notes, the position, or the keys. */
const VISIT_PUBLIC = "id, job_id, checkin_at, checkout_at, summary_en, summary_ar, signed_by_name";

/** Whether `jobId` is a job of the customer `customerId`, on the branch's fenced database. */
const mine = async (sdb: DbStatements, customerId: string, jobId: string): Promise<boolean> => (await sdb.queryOne("select id from app__jobs where customer_id = ? and id = ?", [customerId, jobId])) !== null;

/** Where a self-booking (/book, #775) is done, and who books it. */
export interface BookingPlace {
  readonly name: string;
  /** E.164, the signed-in user's verified phone. */
  readonly phone: string;
  readonly language: "en" | "ar";
  readonly emirate: string;
  readonly area: string;
  readonly address: string;
  readonly makani: string | null;
}

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;

/**
 * The customer and the site of a self-booking in `branchId`, for the portal
 * user `userId` whose verified phone is `place.phone`: the branch's customer
 * row with that phone (the one already linked to the user first, then the
 * oldest), linked to the user when it was not; or a new household with the
 * booking's name and language. An existing customer keeps its data. The site
 * is that customer's site at the same address (compared without case or
 * outer spaces), or a new one labelled "Home". Every statement runs on the
 * branch's fenced database and names the phone or the customer; the caller's
 * transaction holds them together with the job.
 */
export async function bookingCustomer(db: Scopable, branchId: string, userId: string, place: BookingPlace): Promise<{ customer_id: string; site_id: string; created: boolean }> {
  const sdb = branchDb(db, branchId);
  let created = false;
  const found = await sdb.queryOne<{ id: string; user_id: string | null }>(
    "select id, user_id from app__customers where phone = ? and (user_id is null or user_id = ?) order by case when user_id = ? then 0 else 1 end, created_at, id limit 1",
    [place.phone, userId, userId],
  );
  let customerId: string;
  if (found !== null) {
    customerId = found.id;
    if (found.user_id === null) await sdb.execute("update app__customers set user_id = ? where id = ? and phone = ? and user_id is null", [userId, customerId, place.phone]);
  } else {
    customerId = newId("cu");
    created = true;
    await sdb.execute("insert into app__customers (id, branch_id, kind, name, trn, phone, email, language, created_at, user_id) values (?, ?, 'household', ?, null, ?, null, ?, ?, ?)", [
      customerId,
      branchId,
      place.name,
      place.phone,
      place.language,
      now(),
      userId,
    ]);
  }
  const site = await sdb.queryOne<{ id: string }>("select id from app__sites where customer_id = ? and lower(trim(address)) = lower(trim(?)) order by id limit 1", [customerId, place.address]);
  if (site !== null) return { customer_id: customerId, site_id: site.id, created };
  const siteId = newId("st");
  await sdb.execute("insert into app__sites (id, customer_id, branch_id, label, emirate, area, address, makani, lat, lng, access_notes) values (?, ?, ?, 'Home', ?, ?, ?, ?, null, null, '')", [
    siteId,
    customerId,
    branchId,
    place.emirate,
    place.area,
    place.address,
    place.makani,
  ]);
  return { customer_id: customerId, site_id: siteId, created };
}
