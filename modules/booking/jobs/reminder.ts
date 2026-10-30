// A booking's reminder (#334), enqueued 24 h and 2 h before the start when it
// is confirmed: once per kind, only while the booking is still confirmed,
// through email (a WhatsApp template is the whatsapp module's, not wired
// here). The address is the customer's in auth's public view.
import { email } from "renox:modules";

import * as core from "../lib/core.ts";

// Every job route has a schedule (artifact V27); this one is a queue: its
// runs come from confirm()'s enqueue, and the yearly tick (no payload) does nothing.
export const schedule = "0 4 1 1 *";

export async function run(ctx: core.BookingCtx, payload?: { booking_id?: string; kind?: "24h" | "2h" }): Promise<void> {
  if (typeof payload?.booking_id !== "string" || (payload.kind !== "24h" && payload.kind !== "2h")) return;
  const due = await core.reminderDue(ctx, payload.booking_id, payload.kind);
  if (due === null) return;
  const u = await ctx.db.queryOne<{ email: string }>("select email from auth__public_users_v1 where id = ?", [due.customer]);
  if (u === null) return;
  const when = new Date(due.start_at).toISOString().replace("T", " ").slice(0, 16);
  await email.sendRaw({ to: u.email, subject: `Reminder: ${due.service} at ${when} UTC`, text: `Your booking for ${due.service} is at ${when} UTC. To cancel, open your bookings page.` });
}
