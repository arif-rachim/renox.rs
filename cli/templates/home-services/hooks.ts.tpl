// The app's event handlers and hook fillers (docs/07-app-model.md, "Events
// and hooks"). A handler runs after the emitting transaction commits, once per
// event (at least once: each one is idempotent), with a fresh ctx and no
// request: its principal is `System::"app"`, as for the app's jobs.
//
// - `org.member_added`: a person invited from /admin/people has accepted the
//   `org` invitation; the app role chosen for them waits in app__staff_invites
//   and is applied now (lib/admin.ts applyPendingRole), then `app.member_ready`.
// - `app.member_ready` (the app's own event, renox.toml [events]): who invited
//   them is told.
// - `whatsapp.message_received`: a customer's "cancel" or "reschedule" becomes a
//   task for the dispatcher (lib/inbox.ts).
// - the `reports.nightly_to` hook: the nightly summary goes to the accounts
//   email of the settings, read when the job runs.
import type { DbStatements, DeliveredEvent, EventContext } from "@renoxium/sdk";
import { notifications } from "renox:modules";

import { applyPendingRole, inviteOf } from "./lib/admin";
import { handleInbound } from "./lib/inbox";
import { findBranch } from "./lib/scope";
import { getSettings } from "./lib/settings";

type MemberAdded = { org_id: string; user_id: string; role: "owner" | "admin" | "member"; at: number };
type MemberReady = { user_id: string; branch_id: string };
type MessageReceived = { message_id: string; from: string };

export const on = {
  "org.member_added": async (ctx: EventContext, e: DeliveredEvent<MemberAdded>) => {
    const applied = await applyPendingRole(ctx, e.payload.org_id, e.payload.user_id);
    if (applied === null) return;
    await ctx.events.emit("app.member_ready", { user_id: e.payload.user_id, branch_id: applied.branch.id } satisfies MemberReady);
  },

  "app.member_ready": async (ctx: EventContext, e: DeliveredEvent<MemberReady>) => {
    const branch = await findBranch(ctx.db, e.payload.branch_id);
    const who = await inviteOf(ctx.db, e.payload.branch_id, e.payload.user_id);
    if (branch === null || who === null) return;
    const name = who.display_name !== "" ? who.display_name : who.email;
    await notifications.notify(who.invited_by, { category: "staff", title: `${name} joined ${branch.name_en} as ${who.role.replace(/_/gu, " ")}.`, link: "/admin/people" });
  },

  "whatsapp.message_received": async (ctx: EventContext, e: DeliveredEvent<MessageReceived>) => {
    await handleInbound(ctx, e.payload);
  },
};

export const hooks = {
  "reports.nightly_to": {
    /** The module's args are `{ to: string[] }`: a filler pushes onto `to`. No accounts email: nothing, and the summary is kept as a snapshot only. */
    async handle(ctx: { readonly db: DbStatements }, args: { to: string[] }) {
      const to = ((await getSettings(ctx.db)).accounts_email ?? "").trim();
      if (to !== "") args.to.push(to);
    },
  },
};
