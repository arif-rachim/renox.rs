// GET /admin/audit?action=&actor=: the audit trail of the app (the `audit`
// module's query, newest first): the platform's decisions on the sensitive
// actions (invoice.issue, invoice.pay, settings.write, user.manage) and what
// the app records itself (job transitions, customer link answers, settings and
// staff changes, exports). The owner reads it with the audit module's read action,
// which is sensitive: each read is itself a row.
import type { LoaderContext } from "@renoxium/sdk";
import { audit } from "renox:modules";

import { AUDITED } from "../../lib/admin";
import { shell } from "../../lib/page";

export const guard = { action: "settings.read" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const asked = ctx.url.searchParams.get("action") ?? "";
  const action = (AUDITED as readonly string[]).includes(asked) ? asked : "";
  const actor = (ctx.url.searchParams.get("actor") ?? "").trim().slice(0, 64);
  const result = await audit.query({ limit: 100, ...(action === "" ? {} : { action }), ...(actor === "" ? {} : { actor }) });
  return {
    ...page,
    action,
    actor,
    actions: AUDITED.map((value) => ({ value, current: value === action })),
    events: result.events.map((e) => ({
      at: new Date(e.at).toISOString().slice(0, 19).replace("T", " "),
      action: e.action,
      actor: e.actor_id ?? "",
      result: e.result,
      source: e.kind ?? "module",
      resource: e.resource_id ?? "",
    })),
  };
}
