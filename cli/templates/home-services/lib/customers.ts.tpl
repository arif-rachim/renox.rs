// Customer and site statements. Every function takes the branch-scoped Db of
// lib/scope.ts: the branch fence is added to each statement by the platform.
import type { Db } from "@renoxium/sdk";

import type { CustomerInput, SiteInput } from "./forms";

export type CustomerRow = {
  id: string;
  branch_id: string;
  kind: "company" | "household";
  name: string;
  trn: string | null;
  phone: string;
  email: string | null;
  language: "en" | "ar";
  created_at: number;
};

export type SiteRow = {
  id: string;
  customer_id: string;
  label: string;
  emirate: string;
  area: string;
  address: string;
  makani: string | null;
  lat: number | null;
  lng: number | null;
  access_notes: string;
};

const COLUMNS = "id, branch_id, kind, name, trn, phone, email, language, created_at";

/** `q` as a literal LIKE pattern (`%` and `_` escaped). */
const like = (q: string): string => `%${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

/** A customer id from a URL or a form: the ids this app writes are short and plain; anything else is no customer. */
export const customerId = (raw: unknown): string | null => (typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(raw) ? raw : null);

/** The branch's customers whose name or phone contains `q` (the phone as typed, `050…` or `+971…`), by name. */
export async function listCustomers(sdb: Db, q: string): Promise<CustomerRow[]> {
  const digits = q.replace(/\D/gu, "").replace(/^(00971|971|0)/u, "");
  // A phone search needs three digits; with fewer, the pattern "+" matches no stored phone.
  const phone = digits.length >= 3 ? like(digits) : "+";
  return sdb.query<CustomerRow>(`select ${COLUMNS} from app__customers where (name like ?1 escape '\\' or phone like ?2 escape '\\') order by name, id limit 100`, [like(q), phone]);
}

/** One customer of the branch, or null: another branch's id finds nothing. */
export async function findCustomer(sdb: Db, id: unknown): Promise<CustomerRow | null> {
  const key = customerId(id);
  return key === null ? null : sdb.queryOne<CustomerRow>(`select ${COLUMNS} from app__customers where id = ?`, [key]);
}

export async function sitesOf(sdb: Db, customer: string): Promise<SiteRow[]> {
  return sdb.query<SiteRow>("select id, customer_id, label, emirate, area, address, makani, lat, lng, access_notes from app__sites where customer_id = ? order by label, id", [customer]);
}

export async function siteCounts(sdb: Db): Promise<Map<string, number>> {
  const rows = await sdb.query<{ customer_id: string; n: number }>("select customer_id, count(*) as n from app__sites group by customer_id");
  return new Map(rows.map((r) => [r.customer_id, r.n]));
}

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;

export async function insertCustomer(sdb: Db, branch: string, c: CustomerInput, now: number): Promise<string> {
  const id = newId("cu");
  await sdb.execute("insert into app__customers (id, branch_id, kind, name, trn, phone, email, language, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, branch, c.kind, c.name, c.trn, c.phone, c.email, c.language, now]);
  return id;
}

export async function insertSite(sdb: Db, branch: string, customer: string, s: SiteInput): Promise<string> {
  const id = newId("st");
  await sdb.execute("insert into app__sites (id, customer_id, branch_id, label, emirate, area, address, makani, lat, lng, access_notes) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    id,
    customer,
    branch,
    s.label,
    s.emirate,
    s.area,
    s.address,
    s.makani,
    s.lat,
    s.lng,
    s.access_notes,
  ]);
  return id;
}
