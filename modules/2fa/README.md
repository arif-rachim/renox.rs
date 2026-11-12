# 2fa

Two-step verification (`docs/18-build-plan.md` M3; `docs/24-threat-model.md`, "Account takeover"). After the password, or a magic link, OAuth, phone or passkey sign-in, a user who has a second factor confirms it before any session starts. The factor can be an authenticator app (TOTP), a passkey, or a recovery code. The principal then carries `mfa_verified`, so a policy can require it.

The module is named `twofa`, because a module name cannot start with a digit (`manifest.md` MF1). Its tables are `twofa__*` and it is usually mounted at `/2fa`.

## Install

```toml
[modules]
twofa = { version = "^1.0", mount = "/2fa", config = { step_up_minutes = 15 } }
```

```
renox secrets set TWOFA_KEY <32 random bytes, base64>
```

`renox add twofa` asks to approve:

- the hooks `auth.after_login` and `auth.principal`;
- the slot `account.sections`;
- the secret `TWOFA_KEY`, which seals the TOTP secrets and the pending sign-ins.

| Config | Default | Meaning |
| --- | --- | --- |
| `step_up_minutes` | 15 | How long a verification counts, for `mfa_verified` and for `requireRecent` |
| `allow_totp` | `true` | Authenticator apps |
| `allow_passkeys` | `true` | Passkeys as a second factor |
| `recovery_codes` | 10 | Codes per set (4 to 20) |
| `issuer` | `""` | The name authenticator apps show; empty = the host |
| `base_path` | `/2fa` | The mount, for links and redirects |
| `passkey_rp_id`, `passkey_origin` | `""` | The WebAuthn relying party; empty = the request's host |

## Flows

1. **Enrol.** `/2fa/enroll/totp` shows a QR code, drawn as an inline SVG by `lib/qr.ts`, and the key as text. The first code turns TOTP on and shows the recovery codes once. `/2fa/enroll/passkey` registers a passkey. Enrolling counts as a verification of the current session.
2. **Sign in.** auth runs `auth.after_login` with a single-use `resume` ticket.
   - If the user has a factor, this module keeps the ticket, sealed, under a 10-minute `__Host-renox_2fa` cookie, and answers a 303 to `/2fa/verify?next=`. No session exists yet.
   - A correct TOTP code, passkey or recovery code redeems the ticket through `auth.resumeLogin`, which starts the session and emits `auth.login`.
   - The session is recorded as verified (`twofa__sessions`).
3. **Step up.** For a signed-in user, `/2fa/verify` refreshes the session's verification. Removing a factor and making new recovery codes need a recent one.

The rules on codes and attempts:

- A TOTP code works once. A code of the last accepted 30-second step, or an earlier one, is refused (RFC 6238 section 5.2).
- A recovery code works once and is stored as a SHA-256.
- A pending sign-in allows 5 failures, then ends.
- A user gets 10 failures in 15 minutes.

## The principal and policies

The `auth.principal` filler sets `mfa_verified`. It is true while this session's verification is younger than `step_up_minutes`. A policy that needs it:

```cedar
permit (principal is Renox::User, action == Renox::Action::"invoice.refund", resource)
when { principal has mfa_verified && principal.mfa_verified };
```

The cell caches the principal for up to 60 s. A new sign-in, a logout or a role change drops the cache at once. A step-up within an existing session, or the window running out, shows in the principal within that time. An action that must be sure calls `requireRecent`, which reads the table:

```ts
import { twofa } from "renox:modules";

export const actions = {
  async refund(ctx) {
    await twofa.requireRecent({ within: 5, next: ctx.url.pathname }); // throws STEP_UP_REQUIRED with details.verify_url
    // ...
  },
};
```

## Services

| Service | Result |
| --- | --- |
| `isEnrolled(userId)` | Whether the user has TOTP or a passkey |
| `requireRecent({ within?, next? })` | Resolves when this session verified within `within` minutes (default `step_up_minutes`). Otherwise it throws `STEP_UP_REQUIRED` (status 403), with `details.verify_url` |
| `verifiedAt(sessionId)` | Unix ms of the session's last verification, or `null` |
| `reset(userId)` | An administrator resets another user's second factor: `{ reset: true }` when something was deleted, `{ reset: false }` when the user had nothing. Throws `INVALID` (not a user id), `UNAUTHENTICATED` (no signed-in caller), `SELF_RESET` (the target is the caller), `RENOX_FORBIDDEN` (no `twofa.reset` on that user) or `STEP_UP_REQUIRED` (the caller's session has no recent second factor) |

## Reset by an administrator

A user who lost their authenticator app and their recovery codes cannot sign in. `reset(userId)` deletes that user's TOTP secret, passkeys, recovery codes, verified sessions, pending sign-in and passkey challenges, so their next sign-in is not sent to `/2fa/verify` and they enrol again. It reads no secret and returns none.

- **Who may.** Whoever holds the sensitive action `twofa.reset` on that user, granted by the app's policies (the resource is the entity `Twofa::User` with that id, which the module declares in `[authz.entities]`, so a policy reads `permit (principal is Renox::User, action == Renox::Action::"twofa.reset", resource is Twofa::User) when { principal in Renox::Role::"support" };`; the module grants nobody). A decision on a sensitive action writes a `renox__authz_audit` row, allowed or denied.
- **Step-up.** The caller's own session must have passed its second factor within `step_up_minutes` (`requireRecent`), else `STEP_UP_REQUIRED` with `details.verify_url`.
- **No self-reset.** A user cannot reset themselves through it (`SELF_RESET`): they use `/2fa` and their recovery codes.
- **Order.** Every check comes before the first write, so a refusal leaves the data untouched.
- **Event.** `twofa.reset { user_id, by }` (`by` is the administrator), emitted once and only when something was deleted; a second reset of the same user is `{ reset: false }` and emits nothing. No secret is in it. The `audit` module can record it from this event.

## The account page

`partials/account.html` fills auth's slot `account.sections` with a link to `/2fa`. A slot keeps auth free of any knowledge of 2fa, and the link only needs the mount. The rest of the management is on `/2fa`.

## Passkeys here and in auth

A passkey in auth (#291) is a way to sign in without a password. A passkey here is a second factor after one. They are separate tables (`auth__passkeys`, `twofa__webauthn`), so a user may have both.

## Tests

`renox test` in this folder runs `tests/twofa.test.ts` against `tests/app`. That app has i18n, auth and twofa, a refund action that needs `mfa_verified`, and `TWOFA_KEY` in `.env.test`. The tests cover:

- enrolment;
- the halted sign-in and its resumption;
- a replayed TOTP code;
- a recovery code used twice;
- passkeys with the recorded vectors;
- `mfa_verified` and the refund, before and after;
- step-up expiry;
- the verify rate limit;
- the administrator reset (`tests/reset.test.ts`): allowed, refused without the action, without a recent second factor and for oneself, the target enrolling again, the event once;
- English and Arabic snapshots;
- no secret, key or code in logs or snapshots.

The QR encoder was checked module for module against python-qrcode, for versions 1 to 15 and all eight masks. The policy cases are in `policies/tests/2fa.json`.
