// The suppliers the company buys from (#812, wave D): `app__suppliers`, company-wide, kept from /admin/suppliers.
// This module is the one place that reads and writes it; purchase orders (a later issue) pick from
// `listSuppliers(db, { activeOnly: true })`. A supplier is never deleted: `active = 0` keeps its history.
import type { DbStatements } from "@renoxium/sdk";
import { audit, gcc } from "renox:modules";

import { schema, text } from "./forms";

export type SupplierRow = {
  id: string;
  name: string;
  trn: string | null;
  phone: string;
  email: string;
  address: string;
  notes: string;
  active: number;
  created_at: number;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const now = (): number => Math.floor(Date.now() / 1000);
const newId = (): string => `su_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;

export const isSupplierId = (value: unknown): value is string => typeof value === "string" && /^su_[0-9a-f]{16}$/u.test(value);

export interface SupplierInput {
  name: string;
  trn: string | null;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

/** The form of a supplier: name 1 to 120; phone, TRN and email only when present (the gcc module's checks). */
export const supplierSchema = schema<SupplierInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const name = text(raw, "name", 120);
  const trn = text(raw, "trn", 40);
  const phone = text(raw, "phone", 40);
  const email = text(raw, "email", 254);
  const address = text(raw, "address", 300);
  const notes = text(raw, "notes", 1000);
  if (name === "" || name.length > 120) errors.name = "suppliers.err.name";
  let phoneValue = "";
  if (phone !== "") {
    const p = await gcc.validatePhone(phone);
    if (p.ok) phoneValue = p.value;
    else errors.phone = "customers.err.phone";
  }
  let trnValue: string | null = null;
  if (trn !== "") {
    const t = await gcc.validateTrn(trn);
    if (t.ok) trnValue = t.value;
    else errors.trn = "customers.err.trn";
  }
  if (email !== "" && (email.length > 254 || !EMAIL.test(email))) errors.email = "customers.err.email";
  if (address.length > 300) errors.address = "suppliers.err.address";
  if (notes.length > 1000) errors.notes = "suppliers.err.notes";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { name, trn: trnValue, phone: phoneValue, email, address, notes } };
});

/** The suppliers by name; `activeOnly` is what a purchase order offers. */
export async function listSuppliers(db: DbStatements, opts: { activeOnly?: boolean } = {}): Promise<SupplierRow[]> {
  return db.query<SupplierRow>("select id, name, trn, phone, email, address, notes, active, created_at from app__suppliers where (? = 0 or active = 1) order by name collate nocase, id", [opts.activeOnly === true ? 1 : 0]);
}

export async function getSupplier(db: DbStatements, id: unknown): Promise<SupplierRow | null> {
  return isSupplierId(id) ? db.queryOne<SupplierRow>("select id, name, trn, phone, email, address, notes, active, created_at from app__suppliers where id = ?", [id]) : null;
}

type Writer = { readonly db: DbStatements; readonly principal?: { readonly id: string } | null };
const actor = (ctx: Writer) => ({ kind: "user" as const, id: ctx.principal?.id ?? "unknown" });

export async function createSupplier(ctx: Writer, input: SupplierInput): Promise<string> {
  const id = newId();
  await ctx.db.execute("insert into app__suppliers (id, name, trn, phone, email, address, notes, active, created_at) values (?, ?, ?, ?, ?, ?, ?, 1, ?)", [id, input.name, input.trn, input.phone, input.email, input.address, input.notes, now()]);
  await audit.record({ action: "supplier.create", actor: actor(ctx), resource: { type: "Supplier", id }, details: { name: input.name } });
  return id;
}

/** False when there is no such supplier. */
export async function updateSupplier(ctx: Writer, id: string, input: SupplierInput): Promise<boolean> {
  const won = await ctx.db.execute("update app__suppliers set name = ?, trn = ?, phone = ?, email = ?, address = ?, notes = ? where id = ?", [input.name, input.trn, input.phone, input.email, input.address, input.notes, id]);
  if (won.changes !== 1) return false;
  await audit.record({ action: "supplier.update", actor: actor(ctx), resource: { type: "Supplier", id }, details: { name: input.name } });
  return true;
}

export async function setSupplierActive(ctx: Writer, id: string, active: boolean): Promise<boolean> {
  const supplier = await getSupplier(ctx.db, id);
  if (supplier === null) return false;
  await ctx.db.execute("update app__suppliers set active = ? where id = ?", [active ? 1 : 0, id]);
  await audit.record({ action: active ? "supplier.activate" : "supplier.deactivate", actor: actor(ctx), resource: { type: "Supplier", id }, details: { name: supplier.name } });
  return true;
}
