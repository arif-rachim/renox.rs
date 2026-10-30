// The nightly report (#333; ops.md section 20, `export const schedule`): at
// 03:00 UTC, yesterday's sales and cash totals are kept as a snapshot and,
// when config.email_to is set, sent as CSV through the email module.
import { email } from "renox:modules";

import type { Db } from "../lib/cash.ts";
import * as core from "../lib/core.ts";
import { period } from "../lib/report.ts";

export const schedule = "0 3 * * *";

const DAY = 86_400_000;

/** The run: yesterday (UTC) of `now`; the `nightly` service runs the same for a given time. */
export async function nightly(ctx: { db: Db; config: { email_to?: string } }, now = Date.now()): Promise<{ day: string; sent_to: string | null }> {
  const to = Math.floor(now / DAY) * DAY;
  const from = to - DAY;
  const day = new Date(from).toISOString().slice(0, 10);
  const p = await period(ctx.db, from, to);
  const totals = { sales: p.sales, cash: p.cash };
  const to_addr = (ctx.config.email_to ?? "").trim();
  await ctx.db.execute("insert into reports__snapshots (day, totals, sent_to, created_at) values (?, ?, ?, ?) on conflict (day) do update set totals = excluded.totals, sent_to = excluded.sent_to", [day, JSON.stringify(totals), to_addr === "" ? null : to_addr, now]);
  if (to_addr === "") return { day, sent_to: null };
  const text = `Sales ${day}\n\n${core.csv(p.sales as unknown as Record<string, unknown>[])}\nCash ${day}\n\n${core.csv(p.cash as unknown as Record<string, unknown>[])}`;
  await email.sendRaw({ to: to_addr, subject: `Daily report ${day}`, text });
  return { day, sent_to: to_addr };
}

export async function run(ctx: { db: Db; config: { email_to?: string } }): Promise<void> {
  await nightly(ctx);
}
