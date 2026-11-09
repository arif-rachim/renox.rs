// Every minute: the customers' WhatsApp replies in the whatsapp module's inbox
// become tasks for the dispatcher (lib/inbox.ts). A message is handled once, so
// a repeated or coalesced run does nothing more.
import type { JobContext } from "@renoxium/sdk";

import { sweepInbox } from "../lib/inbox";

export const schedule = "* * * * *";

export async function run(ctx: JobContext<never>): Promise<void> {
  await sweepInbox(ctx);
}
