// GET <mount>: the back office's dashboard (admin.access). The cards come
// from the installed modules through the admin.dashboard slot; the counts
// here are the module's own reads (users, the latest audit events).
import { audit } from "renox:modules";

import { admin, iso, type Page } from "../lib/page.ts";

export const guard = { action: "admin.access" };

export const load = admin(async (ctx: Page) => {
  const users = (await ctx.db.queryOne<{ n: number }>("select count(*) as n from auth__public_users_v1"))?.n ?? 0;
  let recent: { at: string; action: string; actor: string }[] | null = null;
  try {
    const page = (await audit.query({ limit: 5 })) as { events: { at: number; action: string; actor_id?: string; actor?: string }[] };
    recent = page.events.map((e) => ({ at: iso(e.at), action: e.action, actor: e.actor_id ?? e.actor ?? "" }));
  } catch {
    // Without the audit read action the card is left out.
  }
  return { title: ctx.config.title ?? "Admin", users, recent };
});
