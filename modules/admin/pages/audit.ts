// GET <mount>/audit?actor=&action=&cursor=: the audit trail through the
// audit module (its own read action applies: an admin without the auditor role
// sees the refusal, not the rows).
import { audit } from "renox:modules";

import { admin, iso, type Page } from "../lib/page.ts";

export const guard = { action: "admin.access" };

export const load = admin(async (ctx: Page) => {
  const p = ctx.url.searchParams;
  const filter: Record<string, unknown> = { limit: 50 };
  for (const k of ["actor", "action", "cursor"]) {
    const v = (p.get(k) ?? "").trim();
    if (v !== "") filter[k] = v.slice(0, 200);
  }
  try {
    const page = (await audit.query(filter)) as { events: { at: number; action: string; actor_id?: string; resource?: string | null; result?: string | null }[]; next: string | null };
    return { allowed: true, actor: p.get("actor") ?? "", action: p.get("action") ?? "", events: page.events.map((e) => ({ at: iso(e.at), action: e.action, actor: e.actor_id ?? "", resource: e.resource ?? "", result: e.result ?? "" })), next: page.next };
  } catch {
    return { allowed: false, actor: "", action: "", events: [], next: null };
  }
});
