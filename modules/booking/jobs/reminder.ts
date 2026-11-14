// A booking's reminder (#334, #799), queued 24 h and 2 h before the start when
// the booking is confirmed: once per kind, only while the booking is still
// confirmed. The queued payload is `ctx.job.payload` (the runtime calls
// `run(ctx)` with one argument). The job first runs the hook `booking.remind`:
// an app that delivers the reminder itself (WhatsApp, SMS) sets `handled`. When
// no filler did, the reminder goes by email to the customer's address in auth's
// public view, and is skipped when the customer has none.
import { email } from "renox:modules";

import * as core from "../lib/core.ts";

// Every job route has a schedule (artifact V27); this one is a queue: its
// runs come from confirm()'s enqueue, and the yearly tick (no payload) does nothing.
export const schedule = "0 4 1 1 *";

export async function run(ctx: core.RemindCtx): Promise<void> {
  await core.remind(ctx, ctx.job?.payload, (m) => email.sendRaw(m));
}
