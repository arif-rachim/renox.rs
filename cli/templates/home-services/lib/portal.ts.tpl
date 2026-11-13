// Customer identity (#774): who is a portal user, and the gate of `/my`.
//
// A portal user is a signed-in person with a verified phone, no password (a
// phone-only account, made by auth's phone sign-up) and no staff role in any
// branch: a staff role always wins. The first time they are seen they get the
// global role `customer` (renox.toml [authz.default_roles], policies/app/base.cedar:
// `portal.*` and nothing else), and they are tied to every customer row with
// their phone, in every branch (lib/customer-db.ts linkCustomers); later checks
// link rows created since. Their data is read through `customerDb` only.
import type { Authz, Principal } from "@renoxium/sdk";
import { auth } from "renox:modules";

import { isStaffRole } from "./admin";
import { customerDb, linkCustomers, type CustomerDb, type PortalCustomer } from "./customer-db";
import type { Scopable } from "./scope";

export { customerDb, type CustomerDb };

export interface PortalUser {
  readonly user_id: string;
  /** E.164, verified. */
  readonly phone: string;
  readonly customer_ids: string[];
  /** The customer rows, with their branch (what customerDb fences by). */
  readonly customers: PortalCustomer[];
  /** The account's display name; empty until the person gives one (/my asks). */
  readonly name: string;
}

export interface PortalCtx {
  readonly db: Scopable;
  readonly principal: Principal | null;
  readonly authz: Pick<Authz, "roles">;
}

/** Whether the user holds a staff role, in any branch or globally. */
export async function isStaff(ctx: Pick<PortalCtx, "authz">, userId: string): Promise<boolean> {
  return (await ctx.authz.roles.list(userId)).some((r) => isStaffRole(r.role));
}

/** The signed-in portal user, or null (signed out, staff, an account with a password, or no verified phone). */
export async function portalUser(ctx: PortalCtx): Promise<PortalUser | null> {
  const user = await auth.currentUser();
  if (user === null) return null;
  const phone = await auth.verifiedPhone();
  if (phone === null || (await auth.hasPassword())) return null;
  const held = await ctx.authz.roles.list(user.id);
  if (held.some((r) => isStaffRole(r.role))) return null;
  if (!held.some((r) => r.role === "customer" && r.scope_type === "global")) await ctx.authz.roles.assign(user.id, "customer");
  const customers = await linkCustomers(ctx.db, user.id, phone);
  return { user_id: user.id, phone, customers, customer_ids: customers.map((c) => c.id), name: user.display_name };
}

const seeOther = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

/**
 * The gate of every `/my` page: a signed-out visitor goes to phone sign-in and
 * comes back here, anyone signed in who is not a portal user (staff) goes to
 * `/`, and a portal user passes with their customer database.
 */
export async function requirePortal(ctx: PortalCtx & { readonly url: URL }): Promise<{ portal: PortalUser; cdb: CustomerDb } | Response> {
  if ((await auth.currentUser()) === null) return seeOther(`/auth/phone?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
  const portal = await portalUser(ctx);
  if (portal === null) return seeOther("/");
  return { portal, cdb: customerDb(ctx.db, portal) };
}

/** The "Sign out" of the portal layout (an action of every `/my` page): the session ends, and the visitor is on `/`. */
export async function signOut(): Promise<Response> {
  const { cookie } = await auth.logout();
  return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie, "cache-control": "no-store" } });
}
