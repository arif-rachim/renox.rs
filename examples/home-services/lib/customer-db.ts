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
}

/**
 * `db` restricted to the portal user's customers: each statement runs once
 * per linked customer, on that customer's branch (`branchDb`) and with
 * `customer_id = ?` bound to it. There is no statement without a customer.
 */
export function customerDb(db: Scopable, portal: PortalScope): CustomerDb {
  const fenced: { sdb: DbStatements; id: string }[] = portal.customers.map((c) => ({ sdb: branchDb(db, c.branch_id), id: c.id }));
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
  };
}

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
