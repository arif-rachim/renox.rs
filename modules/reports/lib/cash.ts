// Cash in and out (#333), from billing's events: payments received and
// refunds, per day of a period, in fils.
export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

/** One billing event; `id` is the outbox's event id (stable across redeliveries). */
export async function record(db: Db, id: string, kind: "received" | "refunded", invoiceId: string, amount: number, at = Date.now()): Promise<void> {
  if (!Number.isInteger(amount) || amount < 0) return;
  await db.execute("insert into reports__cash (id, kind, invoice_id, amount, at) values (?, ?, ?, ?, ?) on conflict (id) do nothing", [id, kind, invoiceId, amount, at]);
}

export interface CashRow {
  date: string;
  received: number;
  refunded: number;
  net: number;
}

export async function cash(db: Db, from: number, to: number): Promise<CashRow[]> {
  const rows = await db.query<{ day: string; kind: string; total: number }>(
    "select strftime('%Y-%m-%d', at / 1000, 'unixepoch') as day, kind, sum(amount) as total from reports__cash where at >= ? and at < ? group by day, kind order by day",
    [from, to],
  );
  const days = new Map<string, CashRow>();
  for (const r of rows) {
    const d = days.get(r.day) ?? { date: r.day, received: 0, refunded: 0, net: 0 };
    if (r.kind === "received") d.received += r.total;
    else d.refunded += r.total;
    d.net = d.received - d.refunded;
    days.set(r.day, d);
  }
  return [...days.values()];
}
