// GET <mount>/audit?actor=&action=&cursor=: the audit trail through the
// audit module (its own read action applies: an admin without the auditor role
// sees the refusal, not the rows).
import { audit } from "renox:modules";

import { admin, iso, view, type Page } from "../lib/page.ts";

export const guard = { action: "admin.access" };

export const load = admin(async (ctx: Page) => {
  const p = ctx.url.searchParams;
  const filter: Record<string, unknown> = { limit: 50 };
  for (const k of ["actor", "action", "cursor"]) {
    const v = (p.get(k) ?? "").trim();
    if (v !== "") filter[k] = v.slice(0, 200);
  }
  try {
    const page = (await audit.query(filter)) as { events: { at: number; action: string; actor_id?: string; actor_kind?: string; client?: string | null; resource_type?: string | null; resource_id?: string | null; result?: string | null }[]; next: string | null };
    return view(ctx, { allowed: true, actor: p.get("actor") ?? "", action: p.get("action") ?? "", events: page.events.map((e) => ({ at: iso(e.at), action: e.action, actor: e.actor_id ?? "", actor_kind: e.actor_kind ?? "user", client: e.client ?? "", resource: [e.resource_type, e.resource_id].filter((x) => x).join(":"), result: e.result ?? "" })), next: page.next });
  } catch {
    return view(ctx, { allowed: false, actor: "", action: "", events: [], next: null });
  }
});
