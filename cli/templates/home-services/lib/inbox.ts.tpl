// The customer's reply on WhatsApp. The whatsapp module stores each inbound
// message in its inbox and emits `whatsapp.message_received` { message_id,
// from }; hooks.ts hands it here, right after the webhook's commit.
//
// "cancel" or "reschedule" (or «إلغاء» / «تغيير الموعد») from the phone of a
// customer becomes a task for the dispatcher (app__tasks) on the customer's
// next scheduled job, a line on that job's timeline, and a notification to the
// dispatcher who made the job. Any other text, and any other phone, only stays
// in the inbox. A delivery may come twice (at least once): the task carries the
// message id, so the second one does nothing.
import { branchDb, type Scopable } from "./scope";
import { notifications, whatsapp } from "renox:modules";

import { type ReplyKind, replyKind } from "./reply";

type CustomerRow = { id: string; branch_id: string; name: string };
type JobRow = { id: string; number: string; created_by: string };

const now = (): number => Math.floor(Date.now() / 1000);

/** Where the reply went: a task (`job` null when the customer has no scheduled job), or nothing. */
export type InboundResult = { task: true; kind: ReplyKind; job: string | null } | { task: false };

/**
 * Handles one inbound message. The event carries the id and the phone, not the
 * text: the module's `message(id)` reads the stored message by its id.
 */
export async function handleInbound(ctx: { readonly db: Scopable }, message: { message_id: string; from: string }): Promise<InboundResult> {
  const m = await whatsapp.message(message.message_id);
  if (m === null) return { task: false };
  const kind = replyKind(m.body);
  if (kind === null) return { task: false };
  // The phone is E.164 in the inbox and in the customer file. The same number in two branches: the oldest customer.
  const customer = await ctx.db.queryOne<CustomerRow>("select id, branch_id, name from app__customers where phone = ? order by created_at, id limit 1", [m.phone]);
  if (customer === null) return { task: false };
  return reply(ctx, customer, kind, m.id);
}

async function reply(ctx: { readonly db: Scopable }, customer: CustomerRow, kind: ReplyKind, messageId: string): Promise<InboundResult> {
  const sdb = branchDb(ctx.db, customer.branch_id);
  const job = await sdb.queryOne<JobRow>("select id, number, created_by from app__jobs where customer_id = ? and status in ('scheduled', 'en_route') order by scheduled_start, number limit 1", [customer.id]);
  const asked = kind === "cancel" ? "cancel" : "reschedule";
  const message = job === null ? `${customer.name} asked to ${asked}, but has no scheduled job.` : `${customer.name} asked to ${asked} job ${job.number}.`;
  const made = await sdb.execute("insert or ignore into app__tasks (branch_id, kind, job_id, message, created_at, message_id) values (?, ?, ?, ?, ?, ?)", [customer.branch_id, kind, job?.id ?? null, message, now(), messageId]);
  // A second delivery of the same message: the task is there already, and so are the timeline line and the notification.
  if (made.changes !== 1) return { task: false };
  if (job === null) return { task: true, kind, job: null };
  await sdb.execute("insert into app__job_events (job_id, branch_id, at, by_user_id, from_status, to_status, note) values (?, ?, ?, null, null, null, ?)", [job.id, customer.branch_id, now(), `customer reply on WhatsApp: ${asked}`]);
  await notifications.notify(job.created_by, { category: "jobs", title: message, link: `/jobs/${job.id}` });
  return { task: true, kind, job: job.id };
}
