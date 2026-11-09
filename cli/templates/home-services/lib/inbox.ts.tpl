// The customer's reply on WhatsApp. The whatsapp module stores each inbound
// message in its inbox and emits its "message received" event, but an app cannot
// subscribe to a module's events and the module has no hook for inbound
// messages (README "Hooks and events"), so jobs/inbox-sweep.ts reads the inbox
// every minute and this file handles what it finds, once per message
// (app__inbox_seen).
//
// "cancel" or "reschedule" (or «إلغاء» / «تغيير الموعد») from the phone of a
// customer becomes a task for the dispatcher (app__tasks) on the customer's
// next scheduled job, a line on that job's timeline, and a notification to the
// dispatcher who made the job. Any other text, and any other phone, only stays
// in the inbox.
import { branchDb, type Scopable } from "./scope";
import type { DbStatements } from "@renoxium/sdk";
import { notifications, whatsapp } from "renox:modules";

import { type ReplyKind, replyKind } from "./reply";

type CustomerRow = { id: string; branch_id: string; name: string };
type JobRow = { id: string; number: string; created_by: string };

const now = (): number => Math.floor(Date.now() / 1000);

export interface SweepResult {
  seen: number;
  tasks: number;
}

/** Handles the inbox messages not handled yet, oldest first. */
export async function sweepInbox(ctx: { readonly db: Scopable }): Promise<SweepResult> {
  const inbox = await whatsapp.inbox({ direction: "in", limit: 200 });
  const result: SweepResult = { seen: 0, tasks: 0 };
  for (const m of [...inbox].reverse()) {
    const marked = await ctx.db.execute("insert or ignore into app__inbox_seen (message_id, seen_at) values (?, ?)", [m.id, now()]);
    if (marked.changes !== 1) continue;
    result.seen += 1;
    const kind = replyKind(m.body);
    if (kind === null) continue;
    // The phone is E.164 in the inbox and in the customer file. The same number in two branches: the oldest customer.
    const customer = await ctx.db.queryOne<CustomerRow>("select id, branch_id, name from app__customers where phone = ? order by created_at, id limit 1", [m.phone]);
    if (customer === null) continue;
    await reply(ctx, customer, kind);
    result.tasks += 1;
  }
  return result;
}

async function reply(ctx: { readonly db: Scopable }, customer: CustomerRow, kind: ReplyKind): Promise<void> {
  const sdb = branchDb(ctx.db, customer.branch_id);
  const job = await sdb.queryOne<JobRow>("select id, number, created_by from app__jobs where customer_id = ? and status in ('scheduled', 'en_route') order by scheduled_start, number limit 1", [customer.id]);
  const asked = kind === "cancel" ? "cancel" : "reschedule";
  const message = job === null ? `${customer.name} asked to ${asked}, but has no scheduled job.` : `${customer.name} asked to ${asked} job ${job.number}.`;
  await sdb.execute("insert into app__tasks (branch_id, kind, job_id, message, created_at) values (?, ?, ?, ?, ?)", [customer.branch_id, kind, job?.id ?? null, message, now()]);
  if (job === null) return;
  await sdb.execute("insert into app__job_events (job_id, branch_id, at, by_user_id, from_status, to_status, note) values (?, ?, ?, null, null, null, ?)", [job.id, customer.branch_id, now(), `customer reply on WhatsApp: ${asked}`]);
  await notifications.notify(job.created_by, { category: "jobs", title: message, link: `/jobs/${job.id}` });
}
