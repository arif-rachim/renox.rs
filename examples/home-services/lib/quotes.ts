// Quotations: statements, the state machine and the form's lines. The statements
// of the branch's own tables take the branch-scoped Db of lib/scope.ts (the
// fence adds branch_id); the number sequence and the public approval page take
// the plain one, with the quotation named by id.
import type { DbStatements } from "@renoxium/sdk";

import { lineTotal, totals, type PricedLine } from "./money";

export const STATUSES = ["draft", "sent", "approved", "rejected", "expired"] as const;
export type QuoteStatus = (typeof STATUSES)[number];

export type QuoteRow = {
  id: string;
  branch_id: string;
  customer_id: string;
  site_id: string;
  number: string;
  status: QuoteStatus;
  valid_until: number;
  notes: string;
  subtotal_fils: number;
  vat_fils: number;
  total_fils: number;
  created_by: string;
  created_at: number;
  approved_at: number | null;
  approved_ip: string | null;
}

export type QuoteLineRow = {
  id: number;
  quote_id: string;
  service_id: number | null;
  description_en: string;
  description_ar: string;
  qty: number;
  unit_price_fils: number;
  vat_rate: number;
  line_total_fils: number;
}

export type ServiceRow = {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  unit: "visit" | "hour" | "unit";
  price_fils: number;
  vat_rate: number;
}

/** A line as validated from the form, before the catalogue fills what was left blank. */
export interface LineInput {
  service_id: number | null;
  description_en: string;
  description_ar: string;
  qty: number;
  unit_price_fils: number | null;
}

/** A line ready to store. */
export interface LineValue extends PricedLine {
  service_id: number | null;
  description_en: string;
  description_ar: string;
}

const COLUMNS = "id, branch_id, customer_id, site_id, number, status, valid_until, notes, subtotal_fils, vat_fils, total_fils, created_by, created_at, approved_at, approved_ip";

const now = (): number => Math.floor(Date.now() / 1000);

const newId = (): string => `qt_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;

/** A quotation id from a URL or a link: plain characters only; anything else is no quotation. */
export const quoteId = (raw: unknown): string | null => (typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(raw) ? raw : null);

/** A `sent` quotation past its date is `expired` (all of the branch's, or the one `id`). `sdb` is fenced to the quotation's branch. */
export async function expireDue(sdb: DbStatements, id?: string): Promise<void> {
  if (id === undefined) await sdb.execute("update app__quotes set status = 'expired' where status = 'sent' and valid_until <= ?", [now()]);
  else await sdb.execute("update app__quotes set status = 'expired' where id = ? and status = 'sent' and valid_until <= ?", [id, now()]);
}

export interface QuoteListRow extends QuoteRow {
  customer_name: string;
}

/** The branch's quotations, newest first, optionally of one status; with the customer's name. */
export async function listQuotes(sdb: DbStatements, status: string): Promise<QuoteListRow[]> {
  const rows = await sdb.query<QuoteRow>(`select ${COLUMNS} from app__quotes where (?1 = '' or status = ?1) order by created_at desc, number desc limit 200`, [status]);
  const names = await sdb.query<{ id: string; name: string }>("select id, name from app__customers", []);
  const byId = new Map(names.map((n) => [n.id, n.name]));
  return rows.map((q) => ({ ...q, customer_name: byId.get(q.customer_id) ?? "" }));
}

export async function findQuote(sdb: DbStatements, id: unknown): Promise<QuoteRow | null> {
  const key = quoteId(id);
  return key === null ? null : sdb.queryOne<QuoteRow>(`select ${COLUMNS} from app__quotes where id = ?`, [key]);
}

export async function linesOf(sdb: DbStatements, quote: string): Promise<QuoteLineRow[]> {
  return sdb.query<QuoteLineRow>("select id, quote_id, service_id, description_en, description_ar, qty, unit_price_fils, vat_rate, line_total_fils from app__quote_lines where quote_id = ? order by id", [quote]);
}

/** The catalogue a branch quotes from: the company's services and the branch's own, active ones. app__services is not an owned table, so the statement names the branch itself. */
export async function catalogueOf(db: DbStatements, branch: string): Promise<ServiceRow[]> {
  return db.query<ServiceRow>("select id, code, name_en, name_ar, unit, price_fils, vat_rate from app__services where active = 1 and (branch_id is null or branch_id = ?) order by id", [branch]);
}

/** The lines with their prices resolved from the catalogue (an unset price is the catalogue's), or the index of the first line whose service is unknown. */
export function resolveLines(inputs: readonly LineInput[], catalogue: readonly ServiceRow[]): { lines: LineValue[] } | { bad: number } {
  const byId = new Map(catalogue.map((s) => [s.id, s]));
  const lines: LineValue[] = [];
  for (const [i, l] of inputs.entries()) {
    if (l.service_id === null) {
      lines.push({ service_id: null, description_en: l.description_en, description_ar: l.description_ar, qty: l.qty, unit_price_fils: l.unit_price_fils ?? 0, vat_rate: 5 });
      continue;
    }
    const s = byId.get(l.service_id);
    if (s === undefined) return { bad: i };
    lines.push({
      service_id: s.id,
      description_en: l.description_en === "" ? s.name_en : l.description_en,
      description_ar: l.description_ar === "" ? (l.description_en === "" ? s.name_ar : l.description_en) : l.description_ar,
      qty: l.qty,
      unit_price_fils: l.unit_price_fils ?? s.price_fils,
      vat_rate: s.vat_rate,
    });
  }
  return { lines };
}

/** Stores a draft quotation with its lines and totals; returns its id. `plain` draws the number, `sdb` writes the branch's rows. */
export async function insertQuote(plain: DbStatements, sdb: DbStatements, q: { branch: string; customer: string; site: string; validUntil: number; notes: string; by: string; lines: readonly LineValue[] }): Promise<string> {
  const id = newId();
  const sum = totals(q.lines);
  const n = await plain.execute("insert into app__quote_numbers (quote_id) values (?)", [id]);
  const number = `Q-${String(Number(n.lastInsertRowid)).padStart(6, "0")}`;
  await sdb.execute("insert into app__quotes (id, branch_id, customer_id, site_id, number, status, valid_until, notes, subtotal_fils, vat_fils, total_fils, created_by, created_at) values (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)", [
    id,
    q.branch,
    q.customer,
    q.site,
    number,
    q.validUntil,
    q.notes,
    sum.subtotal_fils,
    sum.vat_fils,
    sum.total_fils,
    q.by,
    now(),
  ]);
  for (const l of q.lines) {
    await sdb.execute("insert into app__quote_lines (quote_id, branch_id, service_id, description_en, description_ar, qty, unit_price_fils, vat_rate, line_total_fils) values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      q.branch,
      l.service_id,
      l.description_en,
      l.description_ar,
      l.qty,
      l.unit_price_fils,
      l.vat_rate,
      lineTotal(l.qty, l.unit_price_fils, l.vat_rate).net_fils,
    ]);
  }
  return id;
}

/** draft -> sent; false when the quotation was not a draft (or is another branch's: the fence finds nothing). */
export async function markSent(sdb: DbStatements, id: string): Promise<boolean> {
  const r = await sdb.execute("update app__quotes set status = 'sent' where id = ? and status = 'draft'", [id]);
  return r.changes === 1;
}

/** sent -> approved or rejected, once; false when the quotation was no longer `sent`. */
export async function decide(sdb: DbStatements, id: string, to: "approved" | "rejected", ip: string | null): Promise<boolean> {
  const r = await sdb.execute("update app__quotes set status = ?, approved_at = ?, approved_ip = ? where id = ? and status = 'sent' and valid_until > ?", [to, now(), ip, id, now()]);
  return r.changes === 1;
}

/** The lines for a template or the PDF: amounts in AED for the `number(2)` filter, the description in the page's language. */
export function lineView(lines: readonly QuoteLineRow[], locale: string) {
  return lines.map((l) => {
    const a = lineTotal(l.qty, l.unit_price_fils, l.vat_rate);
    return {
      id: l.id,
      description: locale === "ar" ? l.description_ar : l.description_en,
      description_en: l.description_en,
      description_ar: l.description_ar,
      qty: l.qty,
      unit_price: l.unit_price_fils / 100,
      vat_rate: l.vat_rate,
      net: a.net_fils / 100,
      vat: a.vat_fils / 100,
      total: a.total_fils / 100,
    };
  });
}

/** `YYYY-MM-DD` of unix seconds, in the company's time zone (UTC+4, no daylight saving). */
export const day = (seconds: number): string => new Date((seconds + 4 * 3600) * 1000).toISOString().slice(0, 10);
