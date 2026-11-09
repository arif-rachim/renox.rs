// The nightly report (#333; ops.md section 20, `export const schedule`): at
// 03:00 UTC, yesterday's sales and cash totals are kept as a snapshot and,
// when an address is known (the `reports.nightly_to` hook, else config.email_to), sent as CSV through the email module.
import { email } from "renox:modules";

import type { Db } from "../lib/cash.ts";
import * as core from "../lib/core.ts";
import { period } from "../lib/report.ts";

/** `hooks` is the module's `ctx.hooks`; a filler of `reports.nightly_to` pushes addresses onto `args.to`. */
export interface NightlyCtx {
  db: Db;
  config: { email_to?: string };
  hooks?: { run(name: string, args: { to: string[] }): Promise<unknown> };
}

export const schedule = "0 3 * * *";

const DAY = 86_400_000;

/** The run: yesterday (UTC) of `now`; the `nightly` service runs the same for a given time. */
export async function nightly(ctx: NightlyCtx, now = Date.now()): Promise<{ day: string; sent_to: string | null }> {
  const to = Math.floor(now / DAY) * DAY;
  const from = to - DAY;
  const day = new Date(from).toISOString().slice(0, 10);
  const p = await period(ctx.db, from, to);
  const totals = { sales: p.sales, cash: p.cash };
  // The app may choose the address at run time (`reports.nightly_to`); config email_to is the fallback.
  const asked = { to: [] as string[] };
  if (ctx.hooks) await ctx.hooks.run("reports.nightly_to", asked);
  const filled = (Array.isArray(asked.to) ? asked.to : []).filter((a): a is string => typeof a === "string").map((a) => a.trim()).filter((a) => a !== "");
  const fallback = (ctx.config.email_to ?? "").trim();
  const recipients = filled.length > 0 ? [...new Set(filled)] : fallback === "" ? [] : [fallback];
  const to_addr = recipients.join(", ");
  await ctx.db.execute("insert into reports__snapshots (day, totals, sent_to, created_at) values (?, ?, ?, ?) on conflict (day) do update set totals = excluded.totals, sent_to = excluded.sent_to", [day, JSON.stringify(totals), to_addr === "" ? null : to_addr, now]);
  if (to_addr === "") return { day, sent_to: null };
  const text = `Sales ${day}\n\n${core.csv(p.sales as unknown as Record<string, unknown>[])}\nCash ${day}\n\n${core.csv(p.cash as unknown as Record<string, unknown>[])}`;
  for (const to of recipients) await email.sendRaw({ to, subject: `Daily report ${day}`, text });
  return { day, sent_to: to_addr };
}

export async function run(ctx: NightlyCtx): Promise<void> {
  await nightly(ctx);
}
