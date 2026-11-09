// The app's own reports (F7-127), next to the `reports` module's sales page:
// jobs per technician, maintenance contracts that end in a period, and the
// open invoices by age. Each is a header row and rows (`Report`), read through
// the branch-scoped Db of lib/scope.ts, and exported as CSV (the module's `csv`
// service: a UTF-8 BOM, RFC 4180 quoting, a formula guard) or as an .xlsx
// (lib/xlsx.ts). Amounts are fils, as everywhere in the app; hours have two
// decimals. Days are Dubai days.
import type { DbStatements } from "@renoxium/sdk";
import { audit, reports } from "renox:modules";

import { addDays } from "./contract-dates";
import { validDay } from "./contract-forms";
import { day } from "./quotes";
import { type Cell, xlsx } from "./xlsx";

export type ReportRow = Record<string, string | number>;
export interface Report {
  headers: string[];
  rows: ReportRow[];
}

export interface Period {
  /** `YYYY-MM-DD`, included. */
  from: string;
  /** `YYYY-MM-DD`, included. */
  to: string;
}

const now = (): number => Math.floor(Date.now() / 1000);
export const today = (): string => day(now());

/** The period a form or a query names (each end a real day, else the default). */
export function periodOf(get: (key: string) => string | null, fallback: Period): Period {
  const from = get("from") ?? "";
  const to = get("to") ?? "";
  return { from: validDay(from) ? from : fallback.from, to: validDay(to) ? to : fallback.to };
}

/** The last thirty days, today included. */
export const lastThirtyDays = (): Period => ({ from: addDays(today(), -29), to: today() });

/** Unix seconds of the start of a Dubai day (UTC+4). */
const dayStart = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000) - 4 * 3600;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const TECHNICIAN_HEADERS = ["technician", "jobs_done", "hours", "parts_fils"];

/**
 * Per technician: the visits checked out in the period (jobs done), the hours
 * between check-in and check-out, and the value of the parts used (each line
 * rounded to the fil). By the day of check-in. A technician with no finished
 * visit in the period is not listed.
 */
export async function technicianReport(sdb: DbStatements, p: Period): Promise<Report> {
  const from = dayStart(p.from);
  const to = dayStart(p.to) + 86400;
  const visits = await sdb.query<{ id: string; technician_user_id: string; technician_name: string; checkin_at: number; checkout_at: number }>(
    "select id, technician_user_id, technician_name, checkin_at, checkout_at from app__visits where checkout_at is not null and checkin_at >= ? and checkin_at < ?",
    [from, to],
  );
  const parts = await sdb.query<{ visit_id: string; qty: number; unit_price_fils: number }>(
    "select p.visit_id, p.qty, p.unit_price_fils from app__visit_parts p join app__visits v on v.id = p.visit_id where v.checkout_at is not null and v.checkin_at >= ? and v.checkin_at < ?",
    [from, to],
  );
  const partsOf = new Map<string, number>();
  for (const l of parts) partsOf.set(l.visit_id, (partsOf.get(l.visit_id) ?? 0) + Math.round(l.qty * l.unit_price_fils));
  const by = new Map<string, { name: string; jobs: number; seconds: number; parts: number }>();
  for (const v of visits) {
    const e = by.get(v.technician_user_id) ?? { name: v.technician_name === "" ? v.technician_user_id : v.technician_name, jobs: 0, seconds: 0, parts: 0 };
    e.jobs += 1;
    e.seconds += Math.max(0, v.checkout_at - v.checkin_at);
    e.parts += partsOf.get(v.id) ?? 0;
    by.set(v.technician_user_id, e);
  }
  const rows = [...by.values()].sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({ technician: e.name, jobs_done: e.jobs, hours: round2(e.seconds / 3600), parts_fils: e.parts }));
  return { headers: TECHNICIAN_HEADERS, rows };
}

export const AMC_HEADERS = ["contract", "customer", "ends_on", "price_fils", "status", "renewal", "renewed_by"];
export const RENEWAL_STATES = ["renewed", "expired", "reminded", "due"] as const;

/** The next ninety days: what the renewals report shows when no period is asked for. */
export const nextNinetyDays = (): Period => ({ from: today(), to: addDays(today(), 90) });

/**
 * The active and expired contracts that end in the period, by end day. The
 * renewal state: `renewed` (a contract made as its next year, named in
 * `renewed_by`), `expired` (past its end and not renewed), `reminded` (the
 * customer was told it ends: lib/contracts.ts remindRenewals) or `due`.
 */
export async function amcReport(sdb: DbStatements, p: Period): Promise<Report & { ids: string[]; customerIds: string[] }> {
  const contracts = await sdb.query<{ id: string; number: string; customer_id: string; customer_name: string; ends_on: string; price_fils: number; status: string; renewal_notified_on: string | null }>(
    `select c.id, c.number, c.customer_id, cu.name as customer_name, c.ends_on, c.price_fils, c.status, c.renewal_notified_on
     from app__contracts c join app__customers cu on cu.id = c.customer_id
     where c.status in ('active', 'expired') and c.ends_on >= ? and c.ends_on <= ? order by c.ends_on, c.number`,
    [p.from, p.to],
  );
  const renewals = await sdb.query<{ renewed_from: string; number: string }>("select renewed_from, number from app__contracts where renewed_from is not null and status != 'cancelled'", []);
  const renewedBy = new Map(renewals.map((r) => [r.renewed_from, r.number]));
  const rows = contracts.map((c) => {
    const by = renewedBy.get(c.id) ?? "";
    const renewal = by !== "" ? "renewed" : c.status === "expired" ? "expired" : c.renewal_notified_on !== null ? "reminded" : "due";
    return { contract: c.number, customer: c.customer_name, ends_on: c.ends_on, price_fils: c.price_fils, status: c.status, renewal, renewed_by: by };
  });
  return { headers: AMC_HEADERS, rows, ids: contracts.map((c) => c.id), customerIds: contracts.map((c) => c.customer_id) };
}

export const OUTSTANDING_HEADERS = ["customer", "days_0_30_fils", "days_31_60_fils", "days_over_60_fils", "balance_fils"];

/**
 * The branch's open invoices (issued or part-paid) as of now, by customer, the
 * balance (total less payments) split by the age of the invoice since it was
 * issued: 0 to 30 days, 31 to 60, over 60. The biggest balance first.
 */
export async function outstandingReport(sdb: DbStatements, branchId: string, at = now()): Promise<Report & { customerIds: string[] }> {
  const open = await sdb.query<{ customer_id: string; customer_name: string; total_fils: number; paid_fils: number; created_at: number }>(
    `select s.customer_id, c.name as customer_name, s.total_fils, s.paid_fils, s.created_at
     from app__invoice_status s join app__customers c on c.id = s.customer_id
     where s.branch_id = ? and c.branch_id = ? and s.status in ('issued', 'part-paid')`,
    [branchId, branchId],
  );
  const by = new Map<string, { name: string; a: number; b: number; c: number }>();
  for (const i of open) {
    const age = Math.floor((at - i.created_at) / 86400);
    const balance = i.total_fils - i.paid_fils;
    const e = by.get(i.customer_id) ?? { name: i.customer_name, a: 0, b: 0, c: 0 };
    if (age <= 30) e.a += balance;
    else if (age <= 60) e.b += balance;
    else e.c += balance;
    by.set(i.customer_id, e);
  }
  const entries = [...by.entries()].sort(([, x], [, y]) => y.a + y.b + y.c - (x.a + x.b + x.c) || x.name.localeCompare(y.name));
  return {
    headers: OUTSTANDING_HEADERS,
    rows: entries.map(([, e]) => ({ customer: e.name, days_0_30_fils: e.a, days_31_60_fils: e.b, days_over_60_fils: e.c, balance_fils: e.a + e.b + e.c })),
    customerIds: entries.map(([id]) => id),
  };
}

export const FORMATS = ["csv", "xlsx"] as const;
export type Format = (typeof FORMATS)[number];

/** The file of a report: CSV from the `reports` module, or an .xlsx; named `<report>-<stamp>.<format>`. Each export is an audit row. */
export async function download(who: string, name: string, stamp: string, report: Report, format: Format): Promise<Response> {
  await audit.record({ action: "report.export", actor: { kind: "user", id: who }, resource: { type: "Report", id: name }, details: { format, stamp, rows: report.rows.length } });
  const file = `${name}-${stamp}.${format}`;
  if (format === "csv") {
    const body = await reports.csv(report.rows, report.headers);
    return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file}"`, "cache-control": "no-store" } });
  }
  const cells: Cell[][] = [report.headers, ...report.rows.map((r) => report.headers.map((h) => r[h] ?? ""))];
  return new Response(xlsx(name, cells) as BodyInit, {
    headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${file}"`, "cache-control": "no-store" },
  });
}

/** The `csv` or `xlsx` a form asks for (csv when it says neither). */
export const formatOf = (raw: unknown): Format => (raw === "xlsx" ? "xlsx" : "csv");
