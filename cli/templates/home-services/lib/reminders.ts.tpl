// The booking module's reminders (#799). The `booking` module queues a run 24 h
// and 2 h before a confirmed booking and runs its hook `booking.remind` first;
// hooks.ts hands the run here. The booking is found through the job that holds
// its id (app__jobs.booking_id). A job that is gone, cancelled or no longer
// `scheduled` gets nothing, and neither does a second run of the same
// reminder (the message log carries the booking id as `ref_id`).
//
// `handled` is set for every booking that belongs to a job of the app, also
// when nothing is sent: the app's customers are told by WhatsApp or not at all,
// never by `booking`'s own email. It stays false for a booking that no job
// holds (made straight in the module), which keeps the module's default.
import type { Db } from "@renoxium/sdk";

import { clock } from "./booking-sync";
import { notifyCustomer } from "./notify";
import { day } from "./quotes";
import { branchDb, type Scopable } from "./scope";
import { getSettings } from "./settings";

export type RemindArgs = { booking_id: string; kind: "24h" | "2h"; customer: string; service: string; start_at: number; handled: boolean };

type JobRow = { id: string; branch_id: string; customer_id: string; number: string; status: string; scheduled_start: number | null; scheduled_end: number | null };

/** `2026-11-20 09:00-10:00`, Dubai time (seconds in). */
const window = (start: number, end: number | null): string => `${day(start)} ${clock(start)}${end === null || end <= start ? "" : `-${clock(end)}`}`;

/**
 * Fills `args.handled`; sends the customer's WhatsApp reminder when the visit is still on. A hook filler runs
 * in the transaction of the module's job, but the app's `ctx.db` statements do not (and its scoped ones are
 * refused inside it): `transaction` joins that transaction (a savepoint), and `tx` carries `scoped`.
 */
export async function remindCustomer(ctx: { readonly db: Pick<Db, "transaction"> }, args: RemindArgs): Promise<void> {
  await ctx.db.transaction((tx) => remind(tx, args));
}

async function remind(db: Scopable, args: RemindArgs): Promise<void> {
  const ctx = { db };
  const job = await ctx.db.queryOne<JobRow>("select id, branch_id, customer_id, number, status, scheduled_start, scheduled_end from app__jobs where booking_id = ?", [args.booking_id]);
  if (job === null) return;
  args.handled = true;
  if (job.status !== "scheduled" || job.scheduled_start === null) return;
  const kind = args.kind === "24h" ? "reminder_24h" : "reminder_2h";
  const sdb = branchDb(ctx.db, job.branch_id);
  // At least once: the run delivered twice sends one message.
  if ((await sdb.queryOne("select 1 from app__customer_messages where kind = ? and ref_id = ? and customer_id = ?", [kind, args.booking_id, job.customer_id])) !== null) return;
  const branch = await ctx.db.queryOne<{ phone: string }>("select phone from app__branches where id = ?", [job.branch_id]);
  const phone = (branch?.phone ?? "").trim() || ((await getSettings(ctx.db)).company_phone ?? "").trim();
  await notifyCustomer({ db: ctx.db, principal: null }, { id: job.customer_id }, kind, {
    branch_id: job.branch_id,
    ref_id: args.booking_id,
    job_id: job.id,
    vars: { job: job.number, service: args.service, when: window(job.scheduled_start, job.scheduled_end), phone },
  });
}
