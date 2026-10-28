// The account emails of #113 (docs/24-threat-model.md E: verification,
// new-device and new-token notices). Messages hold links with single-use
// tokens and nothing else that is secret; a failed send is logged by kind and
// never fails the request that caused it.

import type { Deps } from "../context.ts";
import type { CreatedToken } from "./tokens.ts";
import { crossTenant } from "../tenancy/scope.ts";
import { link, type Mail } from "./mailer.ts";

async function send(deps: Deps, mail: Mail): Promise<void> {
  try {
    await deps.mailer.send(mail);
  } catch (e) {
    deps.log.error("mail send failed", { kind: mail.kind, error: e instanceof Error ? e.message : String(e) });
  }
}

const base = (deps: Deps): string => deps.config.dashboardUrl;

export const sendVerification = (deps: Deps, to: string, token: string): Promise<void> =>
  send(deps, {
    to,
    kind: "verify_email",
    subject: "Verify your Renox email address",
    text: `Open this link within 24 hours to verify your address:\n\n${link(base(deps), "verify", token)}\n\nYou can deploy once the address is verified.`,
  });

export const sendSignupExists = (deps: Deps, to: string): Promise<void> =>
  send(deps, {
    to,
    kind: "signup_exists",
    subject: "Someone tried to sign up with your address",
    text: `A Renox account already uses this address. If that was you, sign in or reset your password at ${base(deps)}. Otherwise ignore this message.`,
  });

export const sendPasswordReset = (deps: Deps, to: string, token: string): Promise<void> =>
  send(deps, {
    to,
    kind: "password_reset",
    subject: "Reset your Renox password",
    text: `Open this link within one hour to choose a new password. It works once:\n\n${link(base(deps), "reset-password", token)}\n\nIf you did not ask for this, ignore this message.`,
  });

export const sendPasswordChanged = (deps: Deps, to: string): Promise<void> =>
  send(deps, {
    to,
    kind: "password_changed",
    subject: "Your Renox password was changed",
    text: "Your password was changed and every session was signed out. If this was not you, reset your password now and contact support.",
  });

export const sendNewDevice = (deps: Deps, to: string, ip: string | null, userAgent: string | null): Promise<void> =>
  send(deps, {
    to,
    kind: "new_device",
    subject: "New sign-in to your Renox account",
    text: `Your account was signed in from a new browser.\n\nAddress: ${ip ?? "unknown"}\nBrowser: ${(userAgent ?? "unknown").slice(0, 200)}\n\nIf this was not you, open ${base(deps)}, sign out everywhere, and reset your password.`,
  });

export const sendInvitation = (deps: Deps, to: string, tenantId: string, role: string, token: string): Promise<void> =>
  send(deps, {
    to,
    kind: "invitation",
    subject: `You are invited to the Renox tenant ${tenantId}`,
    text: `You are invited to ${tenantId} as ${role}. Sign in with this address and open this link within 7 days:\n\n${link(base(deps), "accept-invitation", token)}`,
  });

export const sendOwnerTransfer = (deps: Deps, to: string, tenantId: string): Promise<void> =>
  send(deps, {
    to,
    kind: "owner_transfer",
    subject: `You are asked to become the owner of ${tenantId}`,
    text: `The owner of ${tenantId} asked to make you the owner. Sign in, switch to ${tenantId}, and accept within 7 days at ${base(deps)}. Until you accept nothing changes.`,
  });

/** The email address of `userId` (a user's own row, not tenant data). */
export async function emailOf(deps: Deps, userId: string): Promise<string | null> {
  const rows = await crossTenant(deps.db, "a user's own email address").query<{ email: string }>("select email from users where id = $1", [userId]);
  return rows[0]?.email ?? null;
}

/** docs/24-threat-model.md E, "Leaked CLI or CI token": a new token is notified to the user it acts for. */
export async function notifyTokenCreated(deps: Deps, userId: string | null, tenantId: string, token: CreatedToken): Promise<void> {
  if (userId === null) return;
  const to = await emailOf(deps, userId);
  if (to === null) return;
  await send(deps, {
    to,
    kind: "token_created",
    subject: `New Renox token for ${tenantId}`,
    text: `A token named "${token.name}" (${token.id}) was created for ${tenantId} with scopes ${token.scopes.join(", ")}; it expires ${new Date(token.expires_at).toISOString()}.\n\nIf this was not you, revoke it with \`renox tokens revoke ${token.id}\` or in the dashboard.`,
  });
}
