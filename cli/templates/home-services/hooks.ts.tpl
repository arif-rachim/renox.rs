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
// - the `booking.remind` hook (#799): the module's 24 h and 2 h reminders of a
//   booking that belongs to a job of the app go out on WhatsApp in the
//   customer's language (lib/reminders.ts), and `handled` keeps the module's
//   own email from also going out.
// - the `auth.after_login` hook (#774): staff cannot use the customer path. A
//   phone sign-in by a user with a staff role and no second factor is refused
//   with a page that sends them to their email and password; no session
//   starts. A staff user WITH a second factor is halted before this filler by
//   2fa's (fillers run by ascending priority, and the first halt ends the
//   hook), so they pass the second factor and land where staff land.
import type { Authz, Db, DbStatements, DeliveredEvent, EventContext } from "@renoxium/sdk";
import { i18n, notifications, twofa } from "renox:modules";

import ar from "./i18n/ar.json";
import en from "./i18n/en.json";
import { markSyncPending } from "./lib/booking-sync";
import { applyPendingRole, inviteOf } from "./lib/admin";
import { isStaff } from "./lib/portal";
import { handleInbound } from "./lib/inbox";
import { remindCustomer, type RemindArgs } from "./lib/reminders";
import { findBranch } from "./lib/scope";
import { getSettings } from "./lib/settings";

type MemberAdded = { org_id: string; user_id: string; role: "owner" | "admin" | "member"; at: number };
type MemberReady = { user_id: string; branch_id: string };
type MessageReceived = { message_id: string; from: string };

export const on = {
  "org.member_added": async (ctx: EventContext, e: DeliveredEvent<MemberAdded>) => {
    const applied = await applyPendingRole(ctx, e.payload.org_id, e.payload.user_id);
    if (applied === null) return;
    // This handler is System::"app", which holds no booking.manage (policies/ stay as they are): a new technician
    // is mirrored into `booking` by the next staff request (lib/page.ts shell).
    if (applied.role === "technician") await markSyncPending(ctx.db);
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

type AfterLogin = { user_id: string; method?: string; next?: string; resume?: string };

/** The page a staff member gets who signed in with their phone and has no second factor: no session started. */
async function staffUsePassword(userId: string, next: string | undefined): Promise<Response> {
  const lang = (await i18n.detectLocale({ user_id: userId, org_locale: null })).locale === "ar" ? "ar" : "en";
  const tree = lang === "ar" ? ar : en;
  const t = tree.portal.staff_phone;
  const back = typeof next === "string" && /^\/(?![/\\])/u.test(next) ? next : "/";
  const href = `/auth/login?next=${encodeURIComponent(back)}`;
  const html = `<!doctype html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t.title}</title><link rel="stylesheet" href="/renox-ui.css"><link rel="stylesheet" href="/app.css"></head>
<body><a class="skip" href="#main">${tree.app.skip}</a><main id="main" tabindex="-1"><h1>${t.title}</h1><p>${t.body}</p><p><a class="btn-brand" href="${href}">${t.signin}</a></p></main></body>
</html>`;
  return new Response(html, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export const hooks = {
  "booking.remind": {
    /** The module's args are `{ booking_id, kind, customer, service, start_at, handled }`: the filler sets `handled` for a booking of one of the app's jobs (lib/reminders.ts). */
    async handle(ctx: { readonly db: Db }, args: RemindArgs) {
      await remindCustomer(ctx, args);
    },
  },

  "auth.after_login": {
    // After 2fa's filler (a module's, priority 100): set explicitly, so the order does not rest on the app-last tie rule.
    priority: 200,
    async handle(ctx: { readonly authz: Pick<Authz, "roles"> }, args: AfterLogin) {
      if (args.method !== "phone") return undefined;
      if (!(await isStaff(ctx, args.user_id))) return undefined;
      // With a second factor, 2fa's filler has halted the sign-in already and asks for it.
      if (await twofa.isEnrolled(args.user_id)) return undefined;
      return { halt: true as const, response: await staffUsePassword(args.user_id, args.next) };
    },
  },

  "reports.nightly_to": {
    /** The module's args are `{ to: string[] }`: a filler pushes onto `to`. No accounts email: nothing, and the summary is kept as a snapshot only. */
    async handle(ctx: { readonly db: DbStatements }, args: { to: string[] }) {
      const to = ((await getSettings(ctx.db)).accounts_email ?? "").trim();
      if (to !== "") args.to.push(to);
    },
  },
};
