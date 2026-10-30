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
