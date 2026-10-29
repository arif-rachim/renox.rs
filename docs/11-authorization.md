# 11 — Authorization: RBAC, ABAC, and relations

There are two different kinds of permission. **Module permissions** (capabilities: what a module's code may do) are declared in `module.toml` and enforced by the sandbox, the SQLite authorizer, and Rust ops (`04-isolation-security.md`). **User permissions** (authorization: what an end user may do) are defined by the tenant application's policies and roles, and evaluated by one policy engine in Rust for all modules. This document covers the second kind.

| Model | Used for | Example |
| --- | --- | --- |
| RBAC | Most permissions, managed through the admin UI | Role `finance` may read and refund invoices |
| ABAC | Rules on user, resource, or context attributes | Refunds above 10,000,000 only by `finance_manager`; sensitive actions require 2FA |
| ReBAC | Ownership and membership | Document owner, organization member, team admin |

## Cedar (D15)

Policies are written in [Cedar](https://www.cedarpolicy.com) and evaluated by `cedar-policy` behind a `PolicyEngine` trait. Native Rust, policies loaded at runtime, RBAC/ABAC/relations in one language, `forbid` wins over `permit`, and policies are validated against a schema at deploy time.

```toml
# modules/billing/module.toml
[authz]
actions   = ["invoice.read", "invoice.create", "invoice.refund"]
sensitive = ["invoice.refund"]                 # requires MFA, audit-logged
[authz.entities]
Invoice = { attrs = ["amount", "org", "status"] }   # only these fields are sent to the engine
[authz.default_roles]
finance = ["invoice.read", "invoice.refund"]
viewer  = ["invoice.read"]
```

```cedar
permit (principal in Role::"finance",
        action in [Action::"invoice.read", Action::"invoice.refund"],
        resource is Billing::Invoice)
when { resource.org == principal.org };

forbid (principal, action == Action::"invoice.refund", resource)
when { resource.amount > 10000000 } unless { principal in Role::"finance_manager" };

forbid (principal, action in Action::"sensitive", resource)
unless { context.mfa_verified };
```

Role assignments live in `renox__role_assignments (user_id, role, scope_type, scope_id)` in the tenant file, so a user can be `finance` in one organization and `viewer` in another. Templates and code always ask about **actions**, never roles; the role → action mapping exists only in policies.

Modules ship default policies under `modules/<module>/policies/`. The app adds policies under `policies/` and may override a module's under `overrides/<module>/policies/`.

**Contract.** The runtime side of this document is `docs/contracts/ops.md` section 17 (1.5.0, #272): the principal reaches Rust through the `auth` module's exported service `auth.principal` (never by the cell reading `auth__sessions`), cached per cell by session id and invalidated by `authz.roles_changed`, `auth.login`, and `auth.logout`; `op_authz_*` and `ctx.authz` (`require`, `can`, `canBatch`, `explain`, `roles`), the `guard` export, `db.scoped()` with `[authz.ownership]`, the append-only `renox__authz_audit` row for sensitive actions, and the evaluation count `authz_evals`. The Cedar schema qualifies the platform types this document writes bare: `Role::"finance"` is `Renox::Role::"finance"`, `Action::"invoice.read"` is `Renox::Action::"invoice.read"`, and a module's `Invoice` is `Billing::Invoice`. The `realtime.authorize` hook of the table below is a policy on `Renox::Topic`, not a hook (`docs/09-htmx-realtime.md`).

## Enforcement points

| Layer | How | Role |
| --- | --- | --- |
| Route | `export const guard = { action: "invoice.read" }` | Rejects before the handler runs; also applies to fragment requests |
| Action | `await ctx.authz.require("invoice.refund", invoiceFromDb)` | ABAC check with the resource loaded from the database, not from the client |
| Data | `db.scoped({ user_id })` + owner columns declared in the manifest | Replacement for RLS: ownership filter applied to every statement |
| UI | `r-can="invoice.refund" :resource="inv"` | Hides elements only; **not a safeguard** |
| Realtime | `realtime.authorize` hook per topic | Prevents subscribing to other users' topics |

Example: the refund button is hidden because `inv.amount > 10,000,000`. The user still sends `POST ?/refund` with curl. The action calls `authz.require("invoice.refund", invoiceFromDb)` and Cedar denies with the same policy. Template and action cannot disagree because the source of truth is one.

## `db.scoped()` — the RLS replacement

```toml
[authz.ownership]
"shop__orders"     = { owner = "user_id", org = "org_id" }
"shop__cart_items" = { owner = "session_id" }
```

`db.scoped({ user_id, org_id })` rewrites statements against declared tables to add the ownership predicate (via SQLite's authorizer callback plus a statement rewriter for `SELECT/UPDATE/DELETE`). Official modules must use `scoped` for user-owned tables, and `renox check` flags unscoped access to tables with declared ownership. This is weaker than database-level RLS and is acknowledged as a trade-off (D16); authorization tests for official modules are mandatory.

## In templates

- `r-can` without a resource: O(1) lookup in the set of actions computed once per request. Cedar is not touched during rendering.
- `r-can` with a resource: one Cedar evaluation per item (microseconds), cached per (action, resource.id) within the request, counted as render fuel. Denied subtrees are not rendered at all.
- Alternative for large pages: `authz.canBatch("invoice.refund", invoices)` in the loader, then `r-if="inv.canRefund"`.
- Undeclared actions or attributes are compile errors at deploy. A resource missing a required attribute yields `deny` and a dev-mode warning.
- Fragment caches include the hash of the user's action set; fragments with resource-based `r-can` are never cached across users.
- Cross-module slots are evaluated with the providing module's actions (`requires` in the manifest).

## Cross-module context and audit

- Each module enforces policies for its own resources; the user identity travels with every service call.
- Event handlers, jobs, and cron run as `System::"<module>"` with explicit permissions, never as a superuser. Admin impersonation is recorded in the context and audit log.
- Decisions for `sensitive` actions are written append-only: who, action, resource, result, deciding policy.
- `renox authz explain --user alice --action invoice.refund --resource inv_123` prints the permitting or forbidding policies; `renox test` runs policy test cases (principal, action, resource, expected result) and per-role template snapshots.

## Performance

- Roles, memberships, and user attributes are loaded once per request and cached per cell; the cache is invalidated by pub/sub when roles or policies change.
- Policies are parsed and validated at deploy, not per request.
- Evaluation count per render counts toward the tenant's quota (together with render fuel), so a template with 10,000 `r-can` checks does not load the platform thread for free.

## Related security layers

| Area | Design |
| --- | --- |
| Authentication | `auth` module: phone-first (+971) OTP via WhatsApp/SMS, passkeys, argon2id passwords, OAuth/OIDC (Google, Apple, Microsoft), **UAE PASS** as an optional provider for resident identity, magic links; session cookies `HttpOnly` `Secure` `SameSite=Lax`; API keys/JWT for machines |
| 2FA | `2fa` module: TOTP and WebAuthn/passkeys via the `auth.after_login` hook and `context.mfa_verified` |
| Rate limiting | Per IP, user, and route at the gateway; strict on login and password reset |
| Input validation | Schema validation in actions and functions before the handler body |
| CSRF, headers | Tokens for all non-GET actions including htmx; CSP, `X-Content-Type-Options`, `Referrer-Policy` |
| Audit | Append-only for logins, role changes, sensitive actions, deploys, secret changes |
