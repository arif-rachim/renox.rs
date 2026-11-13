// Messages to customers. `notifyCustomer` is the one place the app talks to a
// customer. It records every message (app__customer_messages, with the channel
// it took), picks the channel, and tells the staff member who is concerned, in
// the app (the notifications module: the badge updates over SSE).
//
// The channel, for the kinds that go to the customer (lib/messages.ts):
//   - the customer has a phone: WhatsApp, the kind's approved template in the
//     customer's language. Whether it really leaves the host is the whatsapp
//     module's `sandbox` config (renox.toml): with it on, the module records
//     the message as sent and calls no API, and `whatsapp.outbox()` shows it;
//   - no phone: email, when the customer has an address (the sender's display
//     name goes through the email module's `from_name`);
//   - neither: channel 'none', and the job's timeline says so when the message
//     is about a job.
// `quote_approved` and `quote_rejected` are the customer's own answer: only the
// staff member is told.
//
// A module service that throws inside the caller's transaction rolls the whole
// transaction back, so the address is checked first (a valid phone, an address
// that is not suppressed) and a send that cannot work is skipped, not tried.
import { branchDb, type Scopable } from "./scope";
import type { DbStatements } from "@renoxium/sdk";
import { email, gcc, notifications, whatsapp } from "renox:modules";

import { type Language, type MessageKind, renderMessage } from "./messages";
import { brandName, getSettings } from "./settings";

export type CustomerMessageKind = MessageKind | "quote_approved" | "quote_rejected";

interface NotifyCtx {
  readonly db: Scopable;
  readonly principal: { readonly id: string } | null;
  /** The request's URL: its origin makes the customer's links absolute. Jobs have none (the `public_url` setting is used). */
  readonly url?: URL;
}

export interface MessageData {
  branch_id: string;
  ref_id: string;
  /** Who is told in the app: the dispatcher concerned. Optional: no staff notification without it. */
  staff_user?: string;
  /** The staff notification's title and link (a path of the app); its category is `staff_category`. */
  title?: string;
  link?: string;
  staff_category?: string;
  /** The job the message is about: a message nobody could receive is noted on its timeline. */
  job_id?: string;
  /** What the customer's own link opens, a path (`/l/approve/<token>`); put in the text as `{link}`. */
  customer_link?: string;
  /** The values of the kind's placeholders: `number`, `job`, `when`, `technician`, `amount`, `ends`. */
  vars?: Record<string, string>;
}

type CustomerRow = { id: string; name: string; phone: string; email: string | null; language: string };

/** What the email module accepts as a display name (its README, "Config"). */
const SENDER_NAME = /^[^<>\r\n]{1,80}$/u;

const now = (): number => Math.floor(Date.now() / 1000);

export type Channel = "whatsapp" | "email" | "none" | "staff";

/** Records the message for `customer`, sends it by the channel above, and notifies `data.staff_user`. */
export async function notifyCustomer(ctx: NotifyCtx, customer: { id: string }, kind: CustomerMessageKind, data: MessageData): Promise<Channel> {
  const sdb = branchDb(ctx.db, data.branch_id);
  let channel: Channel = "staff";
  let template: string | null = null;
  if (kind !== "quote_approved" && kind !== "quote_rejected") {
    const row = await sdb.queryOne<CustomerRow>("select id, name, phone, email, language from app__customers where id = ?", [customer.id]);
    if (row !== null) {
      const sent = await deliver(ctx, sdb, row, kind, data);
      channel = sent.channel;
      template = sent.template;
    } else channel = "none";
    if (channel === "none" && data.job_id !== undefined) {
      await sdb.execute("insert into app__job_events (job_id, branch_id, at, by_user_id, from_status, to_status, note) values (?, ?, ?, ?, null, null, ?)", [
        data.job_id,
        data.branch_id,
        now(),
        ctx.principal?.id ?? null,
        `no channel: the customer has no phone and no email (${kind})`,
      ]);
    }
  }
  await ctx.db.execute("insert into app__customer_messages (branch_id, customer_id, kind, ref_id, by_user_id, created_at, channel, template) values (?, ?, ?, ?, ?, ?, ?, ?)", [
    data.branch_id,
    customer.id,
    kind,
    data.ref_id,
    ctx.principal?.id ?? null,
    now(),
    channel,
    template,
  ]);
  if (data.staff_user !== undefined && data.title !== undefined) {
    await notifications.notify(data.staff_user, { category: data.staff_category ?? "quotes", title: data.title, ...(data.link === undefined ? {} : { link: data.link }) });
  }
  return channel;
}

/** Tells each of these staff members in the app (the notifications module: the badge updates over SSE); a new self-booking tells the branch's dispatchers (lib/book.ts). */
export async function notifyStaff(userIds: readonly string[], note: { category: string; title: string; link?: string }): Promise<void> {
  for (const id of new Set(userIds)) await notifications.notify(id, { category: note.category, title: note.title, ...(note.link === undefined ? {} : { link: note.link }) });
}

async function deliver(ctx: NotifyCtx, sdb: DbStatements, c: CustomerRow, kind: MessageKind, data: MessageData): Promise<{ channel: Channel; template: string | null }> {
  const settings = await getSettings(ctx.db);
  const language: Language = c.language === "ar" ? "ar" : "en";
  const origin = ctx.url?.origin ?? settings.public_url ?? "";
  // `brand` is the company's name in the customer's language (the subject of the invoice mail carries it).
  const vars = { brand: brandName(settings, language), name: c.name, link: data.customer_link === undefined ? "" : `${origin}${data.customer_link}`, ...data.vars };
  const msg = renderMessage(kind, language, vars);
  const phone = c.phone === "" ? null : await gcc.validatePhone(c.phone);
  const hasPhone = phone !== null && phone.ok;
  let channel: Channel = "none";
  if (hasPhone) {
    await whatsapp.sendTemplate(phone.value, msg.template, msg.params, msg.language);
    return { channel: "whatsapp", template: msg.template };
  }
  const mail = c.email ?? "";
  const address = mail.trim();
  if (address !== "" && !(await email.isSuppressed(address))) {
    // The settings' sender name is the mail's display name. The email module refuses a name over 80 characters or with `<`, `>` or a line break, and a refusal would roll the caller back, so such a name is left out.
    const sender = (settings.sender_name ?? "").trim();
    await email.sendRaw({ to: address, subject: msg.subject, text: msg.body, ...(SENDER_NAME.test(sender) ? { from_name: sender } : {}) });
    channel = "email";
  }
  return { channel, template: msg.template };
}
