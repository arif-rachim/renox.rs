// The tax_gcc module (#331): UAE FTA tax invoices. Amounts are integers in
// fils; VAT is 5 % of the standard-rated lines, rounded half up per line
// (FTA allows per-line or per-invoice rounding; per-line keeps a credit
// note of one line exact). Zero-rated and exempt lines carry no VAT and are
// reported apart. Documents are immutable; numbers have no gaps.

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface TaxCtx {
  db: Db;
  config: { seller_name?: string; seller_trn?: string; seller_address?: string; prefix?: string };
}

export class TaxError extends Error {
  constructor(message: string, readonly code: "INVALID" | "NOT_FOUND" | "NOT_CONFIGURED") {
    super(message);
    this.name = "TaxError";
  }
}

export type Rate = "standard" | "zero" | "exempt";
export const VAT_PERCENT = 5;

export interface Line {
  description: string;
  quantity: number;
  unit_fils: number;
  rate: Rate;
}

export interface DocLine extends Line {
  net_fils: number;
  vat_fils: number;
}

export const vatOfLine = (net: number, rate: Rate): number => (rate === "standard" ? Math.sign(net) * Math.floor((Math.abs(net) * VAT_PERCENT * 2 + 100) / 200) : 0);

export const aed = (fils: number): string => `${fils < 0 ? "-" : ""}${Math.floor(Math.abs(fils) / 100)}.${String(Math.abs(fils) % 100).padStart(2, "0")}`;

const TRN = /^[0-9]{15}$/u;

function lineOf(v: unknown): Line {
  const l = (v ?? {}) as Record<string, unknown>;
  if (typeof l.description !== "string" || l.description.length === 0 || l.description.length > 300) throw new TaxError("line description", "INVALID");
  if (typeof l.quantity !== "number" || !(l.quantity > 0) || l.quantity > 1e6) throw new TaxError("line quantity > 0", "INVALID");
  if (typeof l.unit_fils !== "number" || !Number.isInteger(l.unit_fils) || l.unit_fils < 0) throw new TaxError("line unit_fils: an integer of fils", "INVALID");
  const rate = l.rate ?? "standard";
  if (rate !== "standard" && rate !== "zero" && rate !== "exempt") throw new TaxError("line rate: standard, zero or exempt", "INVALID");
  return { description: l.description, quantity: l.quantity, unit_fils: l.unit_fils, rate };
}

function priced(lines: Line[], sign: 1 | -1): DocLine[] {
  return lines.map((l) => {
    const net = sign * Math.round(l.quantity * l.unit_fils);
    return { ...l, net_fils: net, vat_fils: vatOfLine(net, l.rate) };
  });
}

function totals(lines: DocLine[]) {
  const sum = (r: Rate) => lines.filter((l) => l.rate === r).reduce((s, l) => s + l.net_fils, 0);
  const vat = lines.reduce((s, l) => s + l.vat_fils, 0);
  const standard = sum("standard");
  const zero = sum("zero");
  const exempt = sum("exempt");
  return { standard, zero, exempt, vat, total: standard + zero + exempt + vat };
}

async function nextNumber(ctx: TaxCtx, prefix: string): Promise<string> {
  await ctx.db.execute("insert into tax_gcc__sequences (prefix, next) values (?, 1) on conflict (prefix) do nothing", [prefix]);
  const r = await ctx.db.queryOne<{ next: number }>("update tax_gcc__sequences set next = next + 1 where prefix = ? returning next - 1 as next", [prefix]);
  return `${prefix}-${String(r?.next ?? 1).padStart(6, "0")}`;
}

function seller(ctx: TaxCtx) {
  const trn = ctx.config.seller_trn ?? "";
  if (!TRN.test(trn)) throw new TaxError("seller_trn: the 15-digit TRN", "NOT_CONFIGURED");
  return { name: ctx.config.seller_name ?? "", trn, address: ctx.config.seller_address ?? "" };
}

export async function issue(ctx: TaxCtx, input: { buyer?: { name?: unknown; trn?: unknown; address?: unknown }; lines?: unknown[] }, now = Date.now()) {
  const s = seller(ctx);
  const b = input.buyer ?? {};
  if (typeof b.name !== "string" || b.name.length === 0) throw new TaxError("buyer name", "INVALID");
  if (b.trn !== undefined && !(typeof b.trn === "string" && TRN.test(b.trn))) throw new TaxError("buyer trn: 15 digits", "INVALID");
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) throw new TaxError("1 to 500 lines", "INVALID");
  const lines = priced(input.lines.map(lineOf), 1);
  const t = totals(lines);
  const number = await nextNumber(ctx, ctx.config.prefix ?? "INV");
  const doc = {
    kind: "invoice" as const,
    title: { en: "Tax Invoice", ar: "فاتورة ضريبية" },
    number,
    issued_at: now,
    seller: s,
    buyer: { name: b.name, trn: typeof b.trn === "string" ? b.trn : null, address: typeof b.address === "string" ? b.address : "" },
    lines,
    totals: { ...t, vat_rate: VAT_PERCENT, currency: "AED", display: { standard: aed(t.standard), zero: aed(t.zero), exempt: aed(t.exempt), vat: aed(t.vat), total: aed(t.total) } },
  };
  await ctx.db.execute("insert into tax_gcc__documents (number, kind, body, standard, zero, exempt, vat, issued_at) values (?, 'invoice', ?, ?, ?, ?, ?, ?)", [number, JSON.stringify(doc), t.standard, t.zero, t.exempt, t.vat, now]);
  return doc;
}

export async function invoice(ctx: TaxCtx, number: unknown) {
  if (typeof number !== "string") return null;
  const r = await ctx.db.queryOne<{ body: string }>("select body from tax_gcc__documents where number = ?", [number]);
  return r === null ? null : JSON.parse(r.body);
}

/** A credit note against an issued invoice: all its lines, or the given ones (at most the invoice's). */
export async function creditNote(ctx: TaxCtx, number: unknown, lines: unknown[] | undefined, reason: unknown, now = Date.now()) {
  const inv = await invoice(ctx, number);
  if (inv === null || inv.kind !== "invoice") throw new TaxError("no such invoice", "NOT_FOUND");
  if (typeof reason !== "string" || reason.length < 3) throw new TaxError("a reason", "INVALID");
  const credited = priced((lines ?? inv.lines.map((l: DocLine) => ({ description: l.description, quantity: l.quantity, unit_fils: l.unit_fils, rate: l.rate }))).map(lineOf), -1);
  const t = totals(credited);
  if (-t.total > inv.totals.total) throw new TaxError("a credit note cannot exceed its invoice", "INVALID");
  const cn = await nextNumber(ctx, "CN");
  const doc = { kind: "credit_note" as const, title: { en: "Tax Credit Note", ar: "إشعار دائن ضريبي" }, number: cn, against: inv.number, reason, issued_at: now, seller: inv.seller, buyer: inv.buyer, lines: credited, totals: { ...t, vat_rate: VAT_PERCENT, currency: "AED" } };
  await ctx.db.execute("insert into tax_gcc__documents (number, kind, against, body, standard, zero, exempt, vat, issued_at) values (?, 'credit_note', ?, ?, ?, ?, ?, ?, ?)", [cn, inv.number, JSON.stringify(doc), t.standard, t.zero, t.exempt, t.vat, now]);
  return doc;
}

/** The VAT return boxes of a period (output side): taxable, zero-rated, exempt supplies and output VAT, credit notes netted. */
export async function vatReport(ctx: TaxCtx, from: unknown, to: unknown) {
  const r = await ctx.db.queryOne<{ s: number | null; z: number | null; e: number | null; v: number | null; n: number }>(
    "select sum(standard) as s, sum(zero) as z, sum(exempt) as e, sum(vat) as v, count(*) as n from tax_gcc__documents where issued_at >= ? and issued_at < ?",
    [typeof from === "number" ? from : 0, typeof to === "number" ? to : Number.MAX_SAFE_INTEGER],
  );
  const [s, z, e, v] = [r?.s ?? 0, r?.z ?? 0, r?.e ?? 0, r?.v ?? 0];
  return { standard: s, zero: z, exempt: e, output_vat: v, documents: r?.n ?? 0, display: { standard: aed(s), zero: aed(z), exempt: aed(e), output_vat: aed(v) } };
}

// ---------------------------------------------------------------------------
// #331 F67-B: billing's invoices stamped once, purchases (input VAT), the
// VAT201 boxes, e-invoicing.

/** A tax invoice for a billing invoice, once per source (a redelivered event issues nothing twice). */
export async function stampFromBilling(ctx: TaxCtx, e: { invoice_id: string; customer_id: string; amount: number }, buyer: { name: string; trn?: string | null }, now = Date.now()) {
  const source = `billing:${e.invoice_id}`;
  const linked = await ctx.db.queryOne<{ number: string }>("select number from tax_gcc__links where source = ?", [source]);
  if (linked !== null) return invoice(ctx, linked.number);
  if (!Number.isInteger(e.amount) || e.amount < 0) throw new TaxError("amount in fils", "INVALID");
  const doc = await issue(ctx, { buyer: { name: buyer.name, ...(buyer.trn ? { trn: buyer.trn } : {}) }, lines: [{ description: `Invoice ${e.invoice_id}`, quantity: 1, unit_fils: e.amount, rate: "standard" }] }, now);
  await ctx.db.execute("insert into tax_gcc__links (source, number) values (?, ?)", [source, doc.number]);
  return doc;
}

const newId = (p: string): string => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** A purchase for the input side of the return: net and its recoverable VAT (5 % on standard-rated purchases only). */
export async function recordPurchase(ctx: TaxCtx, p: { supplier?: unknown; supplier_trn?: unknown; net_fils?: unknown; rate?: unknown; booked_at?: unknown }) {
  if (typeof p.supplier !== "string" || p.supplier.length === 0 || p.supplier.length > 200) throw new TaxError("supplier", "INVALID");
  if (p.supplier_trn !== undefined && !(typeof p.supplier_trn === "string" && TRN.test(p.supplier_trn))) throw new TaxError("supplier trn: 15 digits", "INVALID");
  if (typeof p.net_fils !== "number" || !Number.isInteger(p.net_fils) || p.net_fils < 0) throw new TaxError("net_fils: an integer of fils", "INVALID");
  const rate = p.rate ?? "standard";
  if (rate !== "standard" && rate !== "zero" && rate !== "exempt") throw new TaxError("rate: standard, zero or exempt", "INVALID");
  // Input VAT is recoverable only with the supplier's TRN on the tax invoice (FTA).
  const vat = rate === "standard" && typeof p.supplier_trn === "string" ? vatOfLine(p.net_fils, "standard") : 0;
  const id = newId("pur");
  await ctx.db.execute("insert into tax_gcc__purchases (id, supplier, supplier_trn, net, vat, rate, booked_at) values (?, ?, ?, ?, ?, ?, ?)", [id, p.supplier, typeof p.supplier_trn === "string" ? p.supplier_trn : null, p.net_fils, vat, rate, typeof p.booked_at === "number" ? p.booked_at : Date.now()]);
  return { id, net_fils: p.net_fils, vat_fils: vat };
}

/**
 * The FTA VAT return (VAT201) boxes this module can fill for a period, in
 * fils: 1 standard-rated supplies and their VAT, 4 zero-rated, 5 exempt,
 * 8 the totals, 9 standard-rated expenses and their recoverable VAT, 12
 * total due, 13 recoverable, 14 payable (negative: a refund due). Boxes for
 * imports, the reverse charge and the other emirates' split are not kept.
 */
export async function vatReturn(ctx: TaxCtx, from: unknown, to: unknown) {
  const [f, t] = [typeof from === "number" ? from : 0, typeof to === "number" ? to : Number.MAX_SAFE_INTEGER];
  const out = await vatReport(ctx, f, t);
  const inp = await ctx.db.queryOne<{ net: number | null; vat: number | null }>("select sum(net) as net, sum(vat) as vat from tax_gcc__purchases where rate = 'standard' and booked_at >= ? and booked_at < ?", [f, t]);
  const [expenses, recoverable] = [inp?.net ?? 0, inp?.vat ?? 0];
  const boxes = {
    box1_standard_rated_supplies: { amount: out.standard, vat: out.output_vat },
    box4_zero_rated_supplies: { amount: out.zero },
    box5_exempt_supplies: { amount: out.exempt },
    box8_totals: { amount: out.standard + out.zero + out.exempt, vat: out.output_vat },
    box9_standard_rated_expenses: { amount: expenses, vat: recoverable },
    box12_total_value_of_due_tax: out.output_vat,
    box13_total_value_of_recoverable_tax: recoverable,
    box14_payable_tax: out.output_vat - recoverable,
  };
  return { from: f, to: t, boxes, documents: out.documents };
}

/** The return as CSV (box, description, amount AED, VAT AED). */
export function vatReturnCsv(r: Awaited<ReturnType<typeof vatReturn>>): string {
  const b = r.boxes;
  const rows: [string, string, number | null, number | null][] = [
    ["1", "Standard rated supplies", b.box1_standard_rated_supplies.amount, b.box1_standard_rated_supplies.vat],
    ["4", "Zero rated supplies", b.box4_zero_rated_supplies.amount, null],
    ["5", "Exempt supplies", b.box5_exempt_supplies.amount, null],
    ["8", "Totals", b.box8_totals.amount, b.box8_totals.vat],
    ["9", "Standard rated expenses", b.box9_standard_rated_expenses.amount, b.box9_standard_rated_expenses.vat],
    ["12", "Total value of due tax", null, b.box12_total_value_of_due_tax],
    ["13", "Total value of recoverable tax", null, b.box13_total_value_of_recoverable_tax],
    ["14", "Payable tax for the period", null, b.box14_payable_tax],
  ];
  return ["box,description,amount_aed,vat_aed", ...rows.map(([n, d, a, v]) => `${n},${d},${a === null ? "" : aed(a)},${v === null ? "" : aed(v)}`)].join("\n") + "\n";
}

/** Submits an issued document to the e-invoicing provider and records the answer. */
export async function submitEInvoice(ctx: TaxCtx, number: unknown, provider: import("./einvoice.ts").EInvoiceProvider) {
  const doc = await invoice(ctx, number);
  if (doc === null) throw new TaxError("no such document", "NOT_FOUND");
  const r = await provider.submit({ number: doc.number, kind: doc.kind, issued_at: doc.issued_at, seller_trn: doc.seller.trn, buyer_trn: doc.buyer.trn ?? null, total_fils: doc.totals.total, vat_fils: doc.totals.vat });
  await ctx.db.execute(
    "insert into tax_gcc__einvoice (number, provider, provider_id, status, updated_at) values (?, ?, ?, ?, ?) on conflict (number) do update set provider_id = excluded.provider_id, status = excluded.status, updated_at = excluded.updated_at",
    [doc.number, provider.name, r.id, r.status, Date.now()],
  );
  return r;
}
