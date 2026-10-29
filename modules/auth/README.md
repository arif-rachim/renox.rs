# auth

Users, passwords, sessions, and the sign-in pages for a Renox app, as a module (`docs/10-modules.md`; M1 of `docs/18-build-plan.md`). An app that installs it has accounts with no auth code of its own: `examples/shop` is the reference (#241).

## Install

```sh
renox add i18n          # auth's pages take their locale from i18n (#244)
renox add auth          # shows the tables, hosts, secrets and slot it asks for; approve with y
renox migrate           # creates auth__* (renox dev does it on start)
```

`renox.toml`:

```toml
[modules]
auth = { version = "^1.0", mount = "/auth", config = { session_idle_hours = 24 } }
```

The pages are under the mount: `/auth/login`, `/auth/register`, `/auth/account`, `/auth/magic`, `/auth/reset`, and the OAuth routes `/auth/oauth/<provider>/{start,callback}`.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `session_idle_hours` | 24 | A session ends after this many hours without a request |
| `session_absolute_days` | 30 | A session ends this many days after sign-in, used or not; the cookie's `Max-Age` |
| `password_min_length` | 12 | At register, password change, and reset |
| `login_path` | `/auth/login` | Where `requireUser` and `loginUrl` send a signed-out visitor; change it with the mount |
| `google_client_id`, `github_client_id`, `microsoft_client_id` | `""` | OAuth client ids; a provider is on when its id and its secret are set |

## Permissions

| What | Value | Why |
| --- | --- | --- |
| Tables | `auth__*` | users, sessions, identities, tokens, attempts |
| Network | `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `github.com`, `api.github.com`, `login.microsoftonline.com`, `graph.microsoft.com` | OAuth token endpoints, OIDC signing keys, the GitHub API; nothing else |
| Secrets | `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_GITHUB_CLIENT_SECRET`, `AUTH_MICROSOFT_CLIENT_SECRET` | Only for the providers you set up |
| Slots | `app.header` | The user menu |

Other modules read users through the view `auth__public_users_v1` (`id`, `email`, `display_name`, `created_at`), never the tables: the authorizer refuses `auth__users` to them.

## Services

Through `import { auth } from "renox:modules"` (or `ctx.services.auth`):

| Service | Result |
| --- | --- |
| `currentUser()` | The signed-in user of this request, or `null` |
| `currentSession()` | `{ id, user }` of the live session, or `null`. `id` is not the cookie token: other modules key per-session state by it (org's active organisation) |
| `requireUser()` | The user, or throws `AuthRequiredError` (`code: "AUTH_REQUIRED"`, `status: 401`; through the broker, `RENOX_MODULE_SERVICE`) |
| `loginUrl(next?)` | `/auth/login?next=…`; `next` kept only when it is a path of the app |
| `register({ email, password, display_name? })` | `{ message }` (a confirmation link is mailed; the same message when the email already has an account, which gets a mail saying so) or `{ error }` for a bad email or password |
| `login({ email, password })` | `{ user, cookie }` or `{ error }`: the same error for an unknown email, a wrong password, and a locked account |
| `logout()` | `{ cookie }` (clears it); the session is revoked server side |
| `sendMagicLink({ email })`, `requestPasswordReset({ email })` | `{ message }`: the same in every case |
| `confirmPasswordReset({ token, password })` | `{ cookie }` or `{ error }` |
| `verifyAgentToken(token)` | `{ principal, scopes, client: { name } }` for a live agent token, or `null`. The cell calls it for `/mcp` |
| `oauthMetadata(issuer)` | The RFC 8414 document the cell serves at `/.well-known/oauth-authorization-server<mount>/oauth` |
| `listAgentTokens()`, `revokeAgentToken(id)` | The signed-in user's connected agents; revoke one of them |

A page that needs a user:

```ts
import { auth } from "renox:modules";
import { redirect } from "renox";

export async function load(ctx) {
  const user = await auth.currentUser();
  if (user === null) return redirect.safe(await auth.loginUrl(ctx.url.pathname));
  return { auth_user: user };
}
```

## Events

| Event | Payload |
| --- | --- |
| `auth.user_registered` | `{ user_id, at, source: "password" \| "oauth" }` |
| `auth.login` | `{ user_id, at }` |
| `auth.password_changed` | `{ user_id, at }` (a reset) |
| `auth.agent_token_revoked` | `{ token_hash, user_id, at }`: the cell drops the token from its `/mcp` cache |

All durable: written in the transaction of the request, delivered after it commits.

## Hooks

| Hook | When | A filler may |
| --- | --- | --- |
| `auth.before_register` | Before a user is created (`{ email, display_name }`) | Halt with its own response: invite-only, a domain allowlist |
| `auth.after_login` | After the password, magic link, or OAuth check, before any session starts (`{ user_id, next? }`) | Halt with its own response: a second factor (F5); no session is started |
| `auth.agent_audit` | An agent was connected or disconnected (`{ action: "connect" \| "revoke", user_id, client_name, scopes, at }`) | Write an audit row (the `audit` library, #288). Never carries the token |
| `auth.send_mail` | A mail must go out (`{ to, template: "magic_link" \| "password_reset" \| "verify_email" \| "account_exists", args: { url, expires_minutes, display_name } }`) | Send it. auth sends no mail itself until the email module (F7). Fill it from a small module of the app (`modules/mailer`, `permissions.hooks = ["auth.send_mail"]`) |

## Slots

`partials/user-menu.html` fills `app.header` when the app's layout has `<r-slot name="app.header" />`. It shows `auth_user.display_name` with a link to the account page, or "Sign in". A page puts `auth_user: await auth.currentUser()` in its data.

## Overrides

Override a template, never the code: put a copy at `overrides/auth/pages/login.html` (or any `pages/` or `partials/` file) in the app. `renox build` compiles it in place of the original and records the original's hash in the app's `overrides.json`. After `renox add auth` brings a new version whose original changed, `renox build` and `renox check` warn with a diff (`--strict` fails). Update the override, then delete its entry from `overrides.json`.

## Sessions and cookies

- `__Host-renox_auth=<32 random bytes, hex>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=<absolute expiry>`. Only the token's SHA-256 is stored.
- A new session at every sign-in; the browser's previous one is revoked (fixation). A password change revokes every other session and rotates this one.
- This is not the platform's page `session.id` (`ops.md` section 14). That one exists before sign-in, lives as long as the browser keeps it, and carries the CSRF token. A user session has its own lifetime and ends at logout.
- Passwords are argon2id at m = 64 MiB, t = 3, p = 1 through `ctx.password` (a platform op, off the isolate thread). An unknown email is checked against a fixed hash, so it costs the same.
- Failure buckets: 10 per account and 30 per IP address per 15 minutes; past either, the same generic message. Magic and reset links: 5 per email per 15 minutes, single use, 15 minutes, bound to the user agent family that asked.
- OAuth: `state` in a 10-minute `__Host-renox_oauth` cookie, compared in constant time; PKCE S256 for Google and Microsoft; ID tokens verified (RS256 against the provider's keys, issuer, audience, expiry, nonce). An existing account is linked only when the provider verified the email.

## Agents (App MCP)

auth is the OAuth 2.1 authorization server for the app's `/mcp` (`docs/20-ai-agents-mcp.md` section 2). An agent connects as a user and can do only what the user can.

- Discovery: `/.well-known/oauth-protected-resource/mcp` names `https://<host><mount>/oauth`. The cell serves its metadata (RFC 8414) from `oauthMetadata`.
- Registration: `POST <mount>/oauth/register` (RFC 7591). Public clients only (`token_endpoint_auth_method: "none"`). Redirect URIs must be `https`, or `http` on loopback.
- Authorization: `GET <mount>/oauth/authorize`. PKCE S256 is required. A signed-out user goes to the login page first.
- Consent: `<mount>/oauth/consent` lists the client, the user, where it returns, and each scope (`tools:*` or `tools:<name>`), with Allow and Deny. It runs no script of its own and cannot be framed.
- Codes: one minute, single use, stored hashed. A failed exchange also burns the code.
- Token: `POST <mount>/oauth/token` returns `renox_agt_<64 hex>`, valid one hour, with no refresh token. Only its SHA-256 is stored (`auth__agent_tokens`).
- Revoking: the account page's "Connected agents" lists each live token with its client, scopes and last use. "Disconnect" revokes one and emits `auth.agent_token_revoked`, and the cell refuses the token from then on.

Proof: `tests/oauth.test.ts`:

- the full flow;
- a wrong verifier and a reused code;
- a narrowed scope;
- deny;
- no PKCE and an unregistered redirect;
- revoke from the account page;
- a consent page that cannot be framed and sets no cookie.

These keep the `docs/24-threat-model.md` row "Account takeover of a tenant developer" whole: agent tokens are hashed, last one hour, are listed, and can be revoked.

## Policies

`policies/auth.cedar` (a user reads and updates only their own account and revokes only their own sessions) and `policies/tests/auth.json` hold the default policy and its cases. They are files only until the policy engine (F5); `renox test` lists the cases as pending.

## Tests

`renox test` in this folder runs `tests/*.test.ts` in `tests/app/`, with the `reader` and `mailer` fixture modules: register, login, logout, rotation, expiry, buckets, the public view, magic links, reset, OAuth (a fake provider), agents (OAuth 2.1 for `/mcp`), install and upgrade into the shop, and per-role snapshots (`tests/__snapshots__/`).

## Security tests

`tests/negative/` (#100): one file per attack, with the `docs/24-threat-model.md` F4 and `docs/23-failure-modes.md` section 5 rows each one proves.

| File | Case | Expected |
| --- | --- | --- |
| `session-fixation.test.ts` | A session token planted in the victim's browser before sign-in | A new token at sign-in; the planted one is revoked |
| `session-fixation.test.ts` | Password change | This session rotated, every other one signed out |
| `logout.test.ts` | A cookie copied before logout, replayed after | Refused (server-side revocation); "sign out everywhere" ends every session |
| `token-replay.test.ts` | Magic link used twice; from another browser family | Refused; tokens live 15 minutes and are stored hashed |
| `token-replay.test.ts` | Reset token reused, or past 15 minutes | Refused; the password stays |
| `oauth-state-pkce.test.ts` | Callback with a forged state, another flow's state, or no flow cookie | Refused before the code exchange, no session |
| `oauth-state-pkce.test.ts` | Code exchanged with another PKCE verifier | Refused by the provider (a fake Google in the test process) |
| `enumeration.test.ts` | Login, register, reset, magic link for an existing and a missing account | The same status and message, no cookie at register; timing within 20 % |
| `brute-force.test.ts` | 10 failures per account, 30 per IP in 15 minutes | Locked with the generic message, which is snapshotted with the register, reset and magic-link messages; unlocked in the next window |
| `password-hashing.test.ts` | The stored hash | argon2id v19, m = 65536, t = 3, p = 1, 16-byte salt, 32-byte digest, a different salt per user |
| `cookies.test.ts` | The session, logout and OAuth flow cookies | `__Host-`, `Path=/`, no `Domain`, `HttpOnly`, `Secure`, `SameSite=Lax` |

## Language

auth's pages ask `i18n.detectLocale` for the locale, passing the signed-in user, and set it. Their text comes from `i18n/en.json` and `i18n/ar.json`, keys `auth.*`. An app re-words a label with the same key in its own catalog. Messages computed in code (errors, notices) are English for now.
