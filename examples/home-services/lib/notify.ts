// Messages to customers. `notifyCustomer` is the one place the app talks to a
// customer: today it records the message (app__customer_messages) and tells the
// staff member who caused it, in the app; the WhatsApp and email sending of
// the customer's own copy is added here by a later step, behind the same call.
import type { DbStatements } from "@renoxium/sdk";
import { notifications } from "renox:modules";

export type CustomerMessageKind = "quote_sent" | "quote_approved" | "quote_rejected";

interface NotifyCtx {
  readonly db: DbStatements;
  readonly principal: { readonly id: string } | null;
}

export interface MessageData {
  branch_id: string;
  ref_id: string;
  /** Who is told in the app: the dispatcher who sent the quotation, or who created it when the customer answers. */
  staff_user: string;
  title: string;
  link: string;
}

/** Records the message for `customer` and notifies `data.staff_user` (never the customer: no channel exists yet). */
export async function notifyCustomer(ctx: NotifyCtx, customer: { id: string }, kind: CustomerMessageKind, data: MessageData): Promise<void> {
  await ctx.db.execute("insert into app__customer_messages (branch_id, customer_id, kind, ref_id, by_user_id, created_at) values (?, ?, ?, ?, ?, ?)", [
    data.branch_id,
    customer.id,
    kind,
    data.ref_id,
    ctx.principal?.id ?? null,
    Math.floor(Date.now() / 1000),
  ]);
  await notifications.notify(data.staff_user, { category: "quotes", title: data.title, link: data.link });
}
