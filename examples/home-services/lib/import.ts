// Spreadsheet imports (F7-200): the owner brings customers, sites, services and
// contracts in from Excel, one sheet per kind. A file is read from the store
// (`reports.readXlsx`, the first sheet; its first row is the header), parsed row
// by row with the validators the forms use (lib/forms.ts, the gcc module,
// lib/contract-forms.ts), planned against the database (`insert`, `update`,
// `exists`) and reported; nothing but the `app__imports` row is written until
// the commit, which writes the whole file in one transaction (a job attempt's)
// and only for a checked import with no errors. Both run as background jobs
// (jobs/import-check.ts, jobs/import-commit.ts, lib/import-job.ts): the
// action only makes the row (`checking`, `committing`) and enqueues the job.
//
// The error `code`s are i18n keys: `import.err.<code>`. A row's `row` is its
// 1-based sheet row (the header is row 1); a file-level error has row 0.
import type { DbStatements, Principal } from "@renoxium/sdk";
import { audit, reports } from "renox:modules";

import { type ContractInput, validDay } from "./contract-forms";
import { createContract } from "./contracts";
import { insertCustomer, insertSite } from "./customers";
import { customerSchema, emirateOptions, EMIRATES, filsOf, siteSchema, type SiteInput } from "./forms";
import { day } from "./quotes";
import { branchDb, type Scopable } from "./scope";

export const KINDS = ["customers", "sites", "services", "contracts"] as const;
export type ImportKind = (typeof KINDS)[number];
export const isKind = (v: unknown): v is ImportKind => typeof v === "string" && (KINDS as readonly string[]).includes(v);

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 10_000;
/** How many errors the stored report keeps. */
export const MAX_REPORTED = 200;
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type Cell = string | number | null;
export interface RowError {
  /** 1-based sheet row (the header is row 1); 0 for the file as a whole. */
  row: number;
  column: string;
  code: string;
}

/** The columns of each kind, required first (`*`), in the order of the template. */
export const COLUMNS: Record<ImportKind, { name: string; required: boolean }[]> = {
  customers: [
    { name: "branch", required: true },
    { name: "kind", required: true },
    { name: "name", required: true },
    { name: "phone", required: true },
    { name: "email", required: false },
    { name: "trn", required: false },
    { name: "language", required: false },
  ],
  sites: [
    { name: "customer_phone", required: true },
    { name: "label", required: true },
    { name: "emirate", required: true },
    { name: "area", required: true },
    { name: "address", required: true },
    { name: "makani", required: false },
    { name: "access_notes", required: false },
  ],
  services: [
    { name: "code", required: true },
    { name: "name_en", required: true },
    { name: "name_ar", required: true },
    { name: "unit", required: true },
    { name: "price_aed", required: true },
    { name: "vat_rate", required: false },
    { name: "branch", required: false },
  ],
  contracts: [
    { name: "number", required: true },
    { name: "customer_phone", required: true },
    { name: "starts_on", required: true },
    { name: "ends_on", required: true },
    { name: "price_aed", required: true },
    { name: "site_label", required: true },
    { name: "service_code", required: true },
    { name: "visits_per_year", required: true },
    { name: "next_visit_on", required: false },
    { name: "notes", required: false },
  ],
};

/** The template of a kind: the header and two example rows (valid against the seed's branches). */
export const TEMPLATES: Record<ImportKind, Cell[][]> = {
  customers: [
    ["branch", "kind", "name", "phone", "email", "trn", "language"],
    ["Dubai", "company", "Al Noor Trading LLC", "+971 50 123 4567", "accounts@alnoor.example", "100000000000003", "en"],
    ["Sharjah", "household", "Mariam Al Suwaidi", "055 765 4321", null, null, "ar"],
  ],
  sites: [
    ["customer_phone", "label", "emirate", "area", "address", "makani", "access_notes"],
    ["+971 50 123 4567", "Head office", "AE-DU", "Business Bay", "Tower 2, floor 14, Business Bay, Dubai", null, "Ask for the building manager"],
    ["055 765 4321", "Villa", "AE-SH", "Al Nahda", "Villa 12, Street 4, Al Nahda, Sharjah", null, null],
  ],
  services: [
    ["code", "name_en", "name_ar", "unit", "price_aed", "vat_rate", "branch"],
    ["AC-CLEAN", "AC cleaning", "تنظيف المكيفات", "visit", 150, 5, null],
    ["PLUMB-HR", "Plumbing, per hour", "السباكة، بالساعة", "hour", 85.5, 5, "Dubai"],
  ],
  contracts: [
    ["number", "customer_phone", "starts_on", "ends_on", "price_aed", "site_label", "service_code", "visits_per_year", "next_visit_on", "notes"],
    ["C-2026-001", "+971 50 123 4567", "2026-01-01", "2026-12-31", 1800, "Head office", "AC-CLEAN", 4, null, "Quarterly cleaning"],
    ["C-2026-001", "+971 50 123 4567", "2026-01-01", "2026-12-31", 1800, "Head office", "PLUMB-HR", 2, "2026-03-01", null],
  ],
};

const str = (c: Cell | undefined): string => (c === null || c === undefined ? "" : typeof c === "number" ? (Number.isFinite(c) ? String(c) : "") : c.trim());

/** The `YYYY-MM-DD` of a date cell: a text day, or an Excel serial number (days since 1899-12-30). */
function dateOf(c: Cell | undefined): string | null {
  if (typeof c === "number") {
    if (!Number.isFinite(c) || c < 1 || c > 2_958_465) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(c) * 86_400_000).toISOString().slice(0, 10);
  }
  const s = str(c);
  return validDay(s) ? s : null;
}

// ------------------------------------------------------------------ parsing

export interface CustomerIn {
  kind: "customers";
  row: number;
  branch: string;
  customer: { kind: "company" | "household"; name: string; trn: string | null; phone: string; email: string | null; language: "en" | "ar" };
}
export interface SiteIn {
  kind: "sites";
  row: number;
  phone: string;
  site: SiteInput;
}
export interface ServiceIn {
  kind: "services";
  row: number;
  code: string;
  name_en: string;
  name_ar: string;
  unit: "visit" | "hour" | "unit";
  price_fils: number;
  vat_rate: 0 | 5;
  branch: string;
}
export interface ContractIn {
  kind: "contracts";
  row: number;
  number: string;
  phone: string;
  starts_on: string;
  ends_on: string;
  price_fils: number;
  site_label: string;
  service_code: string;
  visits: number;
  next_visit_on: string | null;
  notes: string;
}
export type ParsedRow = CustomerIn | SiteIn | ServiceIn | ContractIn;

/** Looks up a header: the column index by lower-cased name. */
type Reader = (name: string) => Cell;

const KIND_VALUES = ["company", "household"] as const;

/** The areas the gcc module knows are per emirate; the file may carry the emirate as its code or its name in either language. */
function emirateCode(raw: string): string {
  const lower = raw.toLowerCase();
  for (const code of EMIRATES) {
    if (code.toLowerCase() === lower) return code;
    for (const locale of ["en", "ar"]) {
      const name = emirateOptions(locale).find((o) => o.code === code)?.name;
      if (name !== undefined && name.toLowerCase() === lower) return code;
    }
  }
  return raw;
}

const SITE_CODES: Record<string, string> = { label: "too_long", emirate: "bad_emirate", area: "bad_area", address: "too_long", makani: "bad_makani", access_notes: "too_long" };
const CUSTOMER_CODES: Record<string, string> = { name: "too_long", phone: "bad_phone", trn: "bad_trn", email: "bad_email", language: "bad_language" };

/** The first sheet's rows as typed objects. File-level problems (a missing column, too many rows) give no rows. */
export async function parseSheet(kind: ImportKind, cells: readonly (readonly Cell[])[]): Promise<{ rows: ParsedRow[]; errors: RowError[] }> {
  // The size of the file comes first: a file with too many rows is not read any further.
  if (cells.length - 1 > MAX_ROWS) return { rows: [], errors: [{ row: 0, column: "", code: "too_many_rows" }] };
  const errors: RowError[] = [];
  const header = (cells[0] ?? []).map((h) => str(h).toLowerCase());
  const at = new Map<string, number>();
  header.forEach((h, i) => {
    if (h !== "" && !at.has(h)) at.set(h, i);
  });
  for (const col of COLUMNS[kind]) if (col.required && !at.has(col.name)) errors.push({ row: 1, column: col.name, code: "missing_column" });
  if (errors.length > 0) return { rows: [], errors };
  const data = cells.slice(1);

  const rows: ParsedRow[] = [];
  // The gcc module answers per value: the same phone or TRN on many rows asks once.
  for (let i = 0; i < data.length; i++) {
    const line = data[i] as readonly Cell[];
    if (line.every((c) => str(c) === "")) continue;
    const rowNo = i + 2;
    const read: Reader = (name) => {
      const idx = at.get(name);
      return idx === undefined ? null : (line[idx] ?? null);
    };
    const before = errors.length;
    const bad = (column: string, code: string): void => {
      errors.push({ row: rowNo, column, code });
    };
    const need = (column: string): string => {
      const v = str(read(column));
      if (v === "") bad(column, "required");
      return v;
    };
    if (kind === "customers") {
      const branch = need("branch");
      const kindValue = need("kind").toLowerCase();
      const name = need("name");
      const phone = need("phone");
      if (kindValue !== "" && !(KIND_VALUES as readonly string[]).includes(kindValue)) bad("kind", "bad_kind");
      // The form's schema, with the kind it would need a TRN for set aside: a company without a TRN is allowed here.
      const checked = await customerSchema["~standard"].validate({ kind: "household", name, trn: str(read("trn")), phone, email: str(read("email")), language: str(read("language")).toLowerCase() });
      if ("issues" in checked && checked.issues !== undefined) {
        for (const issue of checked.issues) {
          const column = String(issue.path?.[0] ?? "");
          if (errors.some((e) => e.row === rowNo && e.column === column)) continue;
          bad(column, CUSTOMER_CODES[column] ?? "required");
        }
      } else if ("value" in checked && errors.length === before) {
        rows.push({ kind: "customers", row: rowNo, branch, customer: { ...checked.value, kind: kindValue as CustomerIn["customer"]["kind"] } });
      }
    } else if (kind === "sites") {
      const phone = need("customer_phone");
      const label = need("label");
      const emirate = need("emirate");
      const area = need("area");
      const address = need("address");
      const normal = phone === "" ? null : await normalPhone(phone);
      if (phone !== "" && normal === null) bad("customer_phone", "bad_phone");
      const checked = await siteSchema["~standard"].validate({ label, emirate: emirateCode(emirate), area, address, makani: str(read("makani")), access_notes: str(read("access_notes")) });
      if ("issues" in checked && checked.issues !== undefined) {
        for (const issue of checked.issues) {
          const column = String(issue.path?.[0] ?? "");
          if (errors.some((e) => e.row === rowNo && e.column === column)) continue;
          bad(column, SITE_CODES[column] ?? "required");
        }
      } else if ("value" in checked && errors.length === before && normal !== null) {
        rows.push({ kind: "sites", row: rowNo, phone: normal, site: checked.value });
      }
    } else if (kind === "services") {
      const code = need("code").toUpperCase();
      const nameEn = need("name_en");
      const nameAr = need("name_ar");
      const unit = need("unit").toLowerCase();
      const priceRaw = str(read("price_aed"));
      const vatRaw = str(read("vat_rate"));
      if (code !== "" && !/^[A-Z0-9-]{1,32}$/u.test(code)) bad("code", "bad_code");
      if (nameEn.length > 120) bad("name_en", "too_long");
      if (nameAr.length > 120) bad("name_ar", "too_long");
      if (unit !== "" && !["visit", "hour", "unit"].includes(unit)) bad("unit", "bad_unit");
      const fils = priceRaw === "" ? null : filsOf(priceRaw);
      if (priceRaw !== "" && fils === null) bad("price_aed", "bad_price");
      if (priceRaw === "") bad("price_aed", "required");
      if (vatRaw !== "" && vatRaw !== "0" && vatRaw !== "5") bad("vat_rate", "bad_vat");
      if (errors.length === before) {
        rows.push({ kind: "services", row: rowNo, code, name_en: nameEn, name_ar: nameAr, unit: unit as ServiceIn["unit"], price_fils: fils as number, vat_rate: vatRaw === "0" ? 0 : 5, branch: str(read("branch")) });
      }
    } else {
      const number = need("number");
      const phone = need("customer_phone");
      const siteLabel = need("site_label");
      const serviceCode = need("service_code").toUpperCase();
      const priceRaw = need("price_aed");
      const startsRaw = read("starts_on");
      const endsRaw = read("ends_on");
      const visitsRaw = need("visits_per_year");
      if (number !== "" && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/u.test(number)) bad("number", "bad_number");
      const normal = phone === "" ? null : await normalPhone(phone);
      if (phone !== "" && normal === null) bad("customer_phone", "bad_phone");
      if (serviceCode !== "" && !/^[A-Z0-9-]{1,32}$/u.test(serviceCode)) bad("service_code", "bad_code");
      const starts = str(startsRaw) === "" ? (bad("starts_on", "required"), null) : dateOf(startsRaw);
      const ends = str(endsRaw) === "" ? (bad("ends_on", "required"), null) : dateOf(endsRaw);
      if (starts === null && str(startsRaw) !== "") bad("starts_on", "bad_date");
      if (ends === null && str(endsRaw) !== "") bad("ends_on", "bad_date");
      if (starts !== null && ends !== null && ends < starts) bad("ends_on", "bad_range");
      const fils = priceRaw === "" ? null : filsOf(priceRaw);
      if (priceRaw !== "" && fils === null) bad("price_aed", "bad_price");
      const visits = /^\d{1,2}$/u.test(visitsRaw) ? Number(visitsRaw) : 0;
      if (visitsRaw !== "" && (visits < 1 || visits > 52)) bad("visits_per_year", "bad_visits");
      const nextRaw = read("next_visit_on");
      const next = str(nextRaw) === "" ? null : dateOf(nextRaw);
      if (str(nextRaw) !== "" && next === null) bad("next_visit_on", "bad_date");
      else if (next !== null && starts !== null && ends !== null && (next < starts || next > ends)) bad("next_visit_on", "bad_range");
      const notes = str(read("notes"));
      if (notes.length > 1000) bad("notes", "too_long");
      if (errors.length === before && normal !== null && starts !== null && ends !== null && fils !== null) {
        rows.push({ kind: "contracts", row: rowNo, number, phone: normal, starts_on: starts, ends_on: ends, price_fils: fils, site_label: siteLabel, service_code: serviceCode, visits, next_visit_on: next, notes });
      }
    }
  }
  return { rows, errors };
}

const phones = new Map<string, string | null>();
/** A phone as the gcc module normalises it (through the customer form's schema), or null. Cached per value. */
async function normalPhone(raw: string): Promise<string | null> {
  if (phones.has(raw)) return phones.get(raw) as string | null;
  const r = await customerSchema["~standard"].validate({ kind: "household", name: "x", phone: raw });
  const value = "value" in r && r.value !== undefined ? r.value.phone : null;
  if (phones.size > 20_000) phones.clear();
  phones.set(raw, value);
  return value;
}

// ----------------------------------------------------------------- planning

export type Op = "insert" | "update" | "exists";

/** What the plan holds for a row: what to do, and what it was resolved to. */
export interface Planned {
  row: ParsedRow;
  op: Op;
  /** The branch the new row belongs to (customers; sites and contracts: the customer's). */
  branch_id?: string;
  /** The customer a site or contract belongs to. */
  customer_id?: string;
  site_id?: string;
  service_id?: number;
  /** A service's branch (null: every branch). */
  service_branch?: string | null;
}

export interface PlanCtx {
  readonly db: Scopable;
  readonly principal: Principal | null;
}

export interface Plan {
  plan: Planned[];
  errors: RowError[];
  counts: { insert: number; update: number; exists: number };
}

type BranchRow = { id: string; org_id: string; name_en: string; name_ar: string; slug: string };
type CustomerKey = { id: string; branch_id: string; phone: string };

async function branchLookup(db: DbStatements): Promise<(name: string) => BranchRow | undefined> {
  const branches = await db.query<BranchRow>("select id, org_id, name_en, name_ar, slug from app__branches", []);
  const byName = new Map<string, BranchRow>();
  for (const b of branches) for (const n of [b.name_en, b.name_ar, b.slug]) byName.set(n.trim().toLowerCase(), b);
  return (name) => byName.get(name.trim().toLowerCase());
}

async function customersByPhone(db: DbStatements): Promise<Map<string, CustomerKey[]>> {
  const rows = await db.query<CustomerKey>("select id, branch_id, phone from app__customers", []);
  const by = new Map<string, CustomerKey[]>();
  for (const r of rows) by.set(r.phone, [...(by.get(r.phone) ?? []), r]);
  return by;
}

const counted = (plan: Planned[]): Plan["counts"] => ({
  insert: plan.filter((p) => p.op === "insert").length,
  update: plan.filter((p) => p.op === "update").length,
  exists: plan.filter((p) => p.op === "exists").length,
});

/** Resolves the parsed rows against the database and marks each `insert`, `update` or `exists`; what cannot be resolved is an error. */
export async function planImport(ctx: PlanCtx, kind: ImportKind, rows: readonly ParsedRow[]): Promise<Plan> {
  const errors: RowError[] = [];
  const plan: Planned[] = [];
  const fail = (row: number, column: string, code: string): void => {
    errors.push({ row, column, code });
  };

  if (kind === "customers") {
    const branchOf = await branchLookup(ctx.db);
    const known = new Set((await ctx.db.query<{ branch_id: string; phone: string }>("select branch_id, phone from app__customers", [])).map((r) => `${r.branch_id}|${r.phone}`));
    for (const r of rows as CustomerIn[]) {
      const branch = branchOf(r.branch);
      if (branch === undefined) {
        fail(r.row, "branch", "unknown_branch");
        continue;
      }
      const key = `${branch.id}|${r.customer.phone}`;
      plan.push({ row: r, op: known.has(key) ? "exists" : "insert", branch_id: branch.id });
      known.add(key);
    }
  } else if (kind === "sites") {
    const customers = await customersByPhone(ctx.db);
    const known = new Set((await ctx.db.query<{ customer_id: string; label: string }>("select customer_id, label from app__sites", [])).map((r) => `${r.customer_id}|${r.label.toLowerCase()}`));
    for (const r of rows as SiteIn[]) {
      const found = customers.get(r.phone) ?? [];
      if (found.length === 0) {
        fail(r.row, "customer_phone", "unknown_customer");
        continue;
      }
      if (found.length > 1) {
        fail(r.row, "customer_phone", "ambiguous_customer");
        continue;
      }
      const c = found[0] as CustomerKey;
      const key = `${c.id}|${r.site.label.toLowerCase()}`;
      plan.push({ row: r, op: known.has(key) ? "exists" : "insert", branch_id: c.branch_id, customer_id: c.id });
      known.add(key);
    }
  } else if (kind === "services") {
    const branchOf = await branchLookup(ctx.db);
    const known = new Set((await ctx.db.query<{ code: string }>("select code from app__services", [])).map((r) => r.code));
    for (const r of rows as ServiceIn[]) {
      let branchId: string | null = null;
      if (r.branch !== "") {
        const branch = branchOf(r.branch);
        if (branch === undefined) {
          fail(r.row, "branch", "unknown_branch");
          continue;
        }
        branchId = branch.id;
      }
      plan.push({ row: r, op: known.has(r.code) ? "update" : "insert", service_branch: branchId });
      known.add(r.code);
    }
  } else {
    const customers = await customersByPhone(ctx.db);
    const sites = new Map((await ctx.db.query<{ id: string; customer_id: string; label: string }>("select id, customer_id, label from app__sites", [])).map((s) => [`${s.customer_id}|${s.label.toLowerCase()}`, s.id]));
    const services = new Map((await ctx.db.query<{ id: number; code: string; branch_id: string | null; active: number }>("select id, code, branch_id, active from app__services", [])).map((s) => [s.code, s]));
    const numbers = new Set((await ctx.db.query<{ number: string }>("select number from app__contracts", [])).map((r) => r.number));
    const first = new Map<string, ContractIn>();
    for (const r of rows as ContractIn[]) {
      if (numbers.has(r.number)) {
        plan.push({ row: r, op: "exists" });
        continue;
      }
      const head = first.get(r.number);
      if (head === undefined) first.set(r.number, r);
      else {
        const differs = head.phone !== r.phone ? "customer_phone" : head.starts_on !== r.starts_on ? "starts_on" : head.ends_on !== r.ends_on ? "ends_on" : head.price_fils !== r.price_fils ? "price_aed" : null;
        if (differs !== null) {
          fail(r.row, differs, "inconsistent_contract");
          continue;
        }
      }
      const found = customers.get(r.phone) ?? [];
      if (found.length !== 1) {
        fail(r.row, "customer_phone", found.length === 0 ? "unknown_customer" : "ambiguous_customer");
        continue;
      }
      const c = found[0] as CustomerKey;
      const siteId = sites.get(`${c.id}|${r.site_label.toLowerCase()}`);
      const service = services.get(r.service_code);
      let bad = false;
      if (siteId === undefined) {
        fail(r.row, "site_label", "unknown_site");
        bad = true;
      }
      // The service must be one this customer's branch offers (createContract checks the same).
      if (service === undefined || service.active !== 1 || (service.branch_id !== null && service.branch_id !== c.branch_id)) {
        fail(r.row, "service_code", "unknown_service");
        bad = true;
      }
      if (bad) continue;
      plan.push({ row: r, op: "insert", branch_id: c.branch_id, customer_id: c.id, site_id: siteId as string, service_id: (service as { id: number }).id });
    }
  }
  return { plan, errors, counts: counted(plan) };
}

// ------------------------------------------------------------- the stored file

/** A problem with the file as a whole: `not_xlsx`, or `too_many_rows` (over 100,000 cells or 10 MiB). */
export type FileErrorCode = "not_xlsx" | "too_many_rows";

/**
 * The checks of a stored file that need no module service: its size, then the zip signature. What can
 * be known without calling `reports.readXlsx` is known first, which spares the service call.
 */
export function cheapFileError(bytes: Uint8Array): FileErrorCode | null {
  if (bytes.length > MAX_FILE_BYTES) return "too_many_rows";
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return "not_xlsx";
  return null;
}

/** The file-level code of an error thrown by `reports.readXlsx`. */
export const readErrorCode = (e: unknown): FileErrorCode => (/over 100,000 cells|over 10 MiB/u.test(e instanceof Error ? e.message : "") ? "too_many_rows" : "not_xlsx");

/** The first sheet of a stored file; throws when `reports.readXlsx` does (call `cheapFileError` first). */
export async function readCells(bytes: Uint8Array): Promise<Cell[][]> {
  return (await reports.readXlsx(bytes)) as Cell[][];
}

export interface Checked {
  rows: number;
  errors: RowError[];
  plan: Planned[];
  counts: Plan["counts"];
}

/** Parses and plans the cells of a file: the validation rules are the same for the check and the commit. */
export async function checkCells(ctx: PlanCtx, kind: ImportKind, cells: Cell[][]): Promise<Checked> {
  const parsed = await parseSheet(kind, cells);
  const planned = await planImport(ctx, kind, parsed.rows);
  const dataRows = Math.max(0, cells.length - 1);
  const errors = [...parsed.errors, ...planned.errors].sort((a, b) => a.row - b.row);
  return { rows: dataRows, errors, plan: planned.plan, counts: planned.counts };
}

// -------------------------------------------------------------- the import rows

export type ImportStatus = "checking" | "checked" | "committing" | "committed" | "discarded" | "failed";

export type ImportRow = {
  id: string;
  kind: ImportKind;
  file_key: string;
  file_name: string;
  status: ImportStatus;
  rows: number;
  ok: number;
  skipped: number;
  errors: number;
  report: string;
  created_by: string | null;
  created_at: number;
  committed_at: number | null;
  /** `import.err.<code>` of a failed import, null otherwise. */
  error: string | null;
  checked_at: number | null;
};

export interface Report {
  errors: RowError[];
  insert: number;
  update: number;
  exists: number;
}

const now = (): number => Math.floor(Date.now() / 1000);

export const importId = (raw: unknown): string | null => (typeof raw === "string" && /^im_[a-f0-9]{16}$/u.test(raw) ? raw : null);

export async function findImport(db: DbStatements, raw: unknown): Promise<ImportRow | null> {
  const id = importId(raw);
  return id === null ? null : db.queryOne<ImportRow>("select id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at, committed_at, error, checked_at from app__imports where id = ?", [id]);
}

export async function recentImports(db: DbStatements, limit = 10): Promise<(ImportRow & { who: string; when: string })[]> {
  const rows = await db.query<ImportRow & { who: string | null }>(
    `select i.id, i.kind, i.file_key, i.file_name, i.status, i.rows, i.ok, i.skipped, i.errors, i.report, i.created_by, i.created_at, i.committed_at, i.error, i.checked_at,
       (select display_name from auth__public_users_v1 u where u.id = i.created_by) as who
     from app__imports i order by i.created_at desc, i.id desc limit ?`,
    [limit],
  );
  return rows.map((r) => ({ ...r, who: r.who ?? r.created_by ?? "", when: day(r.created_at) }));
}

export const reportOf = (row: Pick<ImportRow, "report">): Report => JSON.parse(row.report) as Report;

/** A stored upload key of this feature: `app/imports/<random>[-stem].xlsx`. */
export const isUploadKey = (key: unknown): key is string => typeof key === "string" && /^app\/imports\/[a-z0-9]{8,40}(-[a-z0-9-]{1,40})?\.xlsx$/u.test(key);

/** The file's name as the page shows it: the key's stem, which `upload_url` made from the browser's file name. */
export function fileNameOf(key: string): string {
  const m = /^app\/imports\/[a-z0-9]+(?:-([a-z0-9-]+))?\.xlsx$/u.exec(key);
  return `${m?.[1] ?? "import"}.xlsx`;
}

export const EMPTY_REPORT = JSON.stringify({ errors: [], insert: 0, update: 0, exists: 0 } satisfies Report);

/** Makes the import row of an uploaded file, `checking`; the job `import-check` fills it in. Answers its id. */
export async function startImport(ctx: { readonly db: DbStatements; readonly principal: Principal | null }, kind: ImportKind, key: string): Promise<string> {
  const id = `im_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;
  await ctx.db.execute(
    "insert into app__imports (id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at) values (?, ?, ?, ?, 'checking', 0, 0, 0, 0, ?, ?, ?)",
    [id, kind, key, fileNameOf(key), EMPTY_REPORT, ctx.principal?.id ?? null, now()],
  );
  return id;
}

/** Keeps the result of the check: the report, the counts and `checked`. Only a `checking` row is changed. */
export async function finishCheck(db: DbStatements, id: string, result: Checked): Promise<void> {
  const report: Report = { errors: result.errors.slice(0, MAX_REPORTED), ...result.counts };
  const at = now();
  await db.execute("update app__imports set status = 'checked', rows = ?, ok = ?, skipped = ?, errors = ?, report = ?, checked_at = ? where id = ? and status = 'checking'", [
    result.rows,
    result.counts.insert + result.counts.update,
    result.counts.exists,
    result.errors.length,
    JSON.stringify(report),
    at,
    id,
  ]);
}

/**
 * Ends a `checking` or `committing` import as `failed` with the i18n key `import.err.<code>`. A failed
 * check has no report of its own (the empty one stays); a failed commit keeps the report of its check.
 */
export async function failImport(db: DbStatements, id: string, from: "checking" | "committing", code: string): Promise<void> {
  await db.execute("update app__imports set status = 'failed', error = ? where id = ? and status = ?", [`import.err.${code}`, id, from]);
}

/** Asks for the commit of a `checked` import with no errors: `committing`, until `import-commit` has run. False when the row is not in that state. */
export async function startCommit(db: DbStatements, id: string): Promise<boolean> {
  const done = await db.execute("update app__imports set status = 'committing' where id = ? and status = 'checked' and errors = 0", [id]);
  return done.changes === 1;
}

export type CommitDone = { ok: true; counts: Plan["counts"] } | { ok: false; code: "data_changed" };

/**
 * Writes the whole file of a `committing` import through the plan of `checkCells`, so a file whose data
 * changed since the check (a customer it names was removed) is refused (`data_changed`) rather than
 * half-written. The caller (jobs/import-commit.ts) runs it in the attempt's one transaction: a throw
 * anywhere rolls every row back. `by` is the user who asked for the import (the audit row's actor).
 */
export async function commitChecked(ctx: PlanCtx, row: ImportRow, result: Checked, by: string): Promise<CommitDone> {
  if (result.errors.length > 0) return { ok: false, code: "data_changed" };
  if (row.kind === "customers") await writeCustomers(ctx, result.plan);
  else if (row.kind === "sites") await writeSites(ctx, result.plan);
  else if (row.kind === "services") await writeServices(ctx, result.plan);
  else await writeContracts(ctx, result.plan);
  const report: Report = { errors: [], ...result.counts };
  await ctx.db.execute("update app__imports set status = 'committed', committed_at = ?, rows = ?, ok = ?, skipped = ?, report = ? where id = ? and status = 'committing'", [
    now(),
    result.rows,
    result.counts.insert + result.counts.update,
    result.counts.exists,
    JSON.stringify(report),
    row.id,
  ]);
  await audit.record({
    action: "import.committed",
    actor: { kind: "user", id: by },
    resource: { type: "Import", id: row.id },
    details: { kind: row.kind, rows: result.rows, inserted: result.counts.insert, updated: result.counts.update, existing: result.counts.exists },
  });
  return { ok: true, counts: result.counts };
}

async function writeCustomers(ctx: PlanCtx, plan: Planned[]): Promise<void> {
  const at = now();
  for (const p of plan) {
    if (p.op !== "insert") continue;
    const r = p.row as CustomerIn;
    const branch = p.branch_id as string;
    await insertCustomer(branchDb(ctx.db, branch), branch, r.customer, at);
  }
}

async function writeSites(ctx: PlanCtx, plan: Planned[]): Promise<void> {
  for (const p of plan) {
    if (p.op !== "insert") continue;
    const branch = p.branch_id as string;
    await insertSite(branchDb(ctx.db, branch), branch, p.customer_id as string, (p.row as SiteIn).site);
  }
}

async function writeServices(ctx: PlanCtx, plan: Planned[]): Promise<void> {
  for (const p of plan) {
    const r = p.row as ServiceIn;
    // An existing code keeps its row (and its `active` flag); the rest follows the file.
    if (p.op === "update") {
      await ctx.db.execute("update app__services set branch_id = ?, name_en = ?, name_ar = ?, unit = ?, price_fils = ?, vat_rate = ? where code = ?", [p.service_branch ?? null, r.name_en, r.name_ar, r.unit, r.price_fils, r.vat_rate, r.code]);
    } else if (p.op === "insert") {
      await ctx.db.execute("insert into app__services (branch_id, code, name_en, name_ar, unit, price_fils, vat_rate, active) values (?, ?, ?, ?, ?, ?, ?, 1)", [p.service_branch ?? null, r.code, r.name_en, r.name_ar, r.unit, r.price_fils, r.vat_rate]);
    }
  }
}

/** One draft contract per number, in the customer's branch, with one item per row (`createContract`); the file's number replaces the generated one. */
async function writeContracts(ctx: PlanCtx, plan: Planned[]): Promise<void> {
  const groups = new Map<string, Planned[]>();
  for (const p of plan) {
    if (p.op !== "insert") continue;
    const number = (p.row as ContractIn).number;
    groups.set(number, [...(groups.get(number) ?? []), p]);
  }
  const branches = new Map((await ctx.db.query<{ id: string; org_id: string }>("select id, org_id from app__branches", [])).map((b) => [b.id, b.org_id]));
  const principal = ctx.principal;
  if (principal === null) throw new Error("import: no principal");
  for (const [number, items] of groups) {
    const head = items[0] as Planned;
    const first = head.row as ContractIn;
    const branchId = head.branch_id as string;
    // createContract works in the principal's active branch: the customer's branch, for this call.
    const inBranch = { db: ctx.db, principal: { ...principal, attrs: { ...principal.attrs, org: branches.get(branchId) as string } } };
    const input: ContractInput = {
      customer_id: head.customer_id as string,
      starts_on: first.starts_on,
      ends_on: first.ends_on,
      price_fils: first.price_fils,
      notes: items.map((p) => (p.row as ContractIn).notes).find((n) => n !== "") ?? "",
      items: items.map((p) => ({ site_id: p.site_id as string, service_id: p.service_id as number, visits_per_year: (p.row as ContractIn).visits })),
    };
    const made = await createContract(inBranch, input);
    if (!made.ok) throw new Error(`import: contract ${number}: ${made.message}`);
    const sdb = branchDb(ctx.db, branchId);
    await sdb.execute("update app__contracts set number = ? where id = ?", [number, made.value.id]);
    const ids = await sdb.query<{ id: number }>("select id from app__contract_items where contract_id = ? order by id", [made.value.id]);
    for (let i = 0; i < items.length; i++) {
      const next = (items[i]?.row as ContractIn).next_visit_on;
      if (next !== null) await sdb.execute("update app__contract_items set next_visit_on = ? where id = ?", [next, ids[i]?.id as number]);
    }
  }
}
