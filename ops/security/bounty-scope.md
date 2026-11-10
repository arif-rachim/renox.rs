# Bug bounty: scope, rules, severity (DRAFT)

**Status: DRAFT, not published.** Nothing here is an offer to pay anyone. The owner publishes this page (and changes the "Bug bounty" section of `SECURITY.md` to point at the published programme) after the first external user is on the platform (D31; F7 gate, #86). Until then `SECURITY.md` governs: reports are welcome, reporters are credited, nothing is paid.

Related: the threat model this scope is cut from, `docs/24-threat-model.md`; the scope given to a hired tester, `ops/security/pentest-scope.md`; the severity levels and response, `ops/security/incident-runbook.md` ("Severity"); the disclosure policy, `SECURITY.md`. Owner: the security lead.

## In scope

| Target | Notes | Threat-model section |
| --- | --- | --- |
| Tenant apps on `*.renoxium.app` that the platform owner runs (the platform tenant's own apps, and test tenants you create yourself) | The gateway, the runtime, the per-tenant SQLite file and its authorizer, templates and the default header set, as seen through an app | A, B, C |
| `api.renoxium.com` | The deploy API, the platform MCP (OAuth 2.1), the node-facing surface (must not be reachable from the internet, ADR D23) | E |
| `dashboard.renoxium.com` | Sessions, MFA, account recovery, the team and token screens | E |
| `renoxium.com` | The site and the platform's own hosts (`mcp.`, `docs.`) | E |
| `@renoxium/cli` and `@renoxium/sdk` (npm), and the `renox-worker` release they pin | Credential handling, release verification, helpers such as `redirect.safe()` and `webhook.verify` | A, F |
| The official modules under `modules/` | Code and migrations of the modules we publish, as installed in your own tenant | D |

A target not listed here is out of scope. Custom domains are in scope only as far as the platform serves them (domain takeover, certificate issuance for an unverified host); the tenant's own site behind it is not.

## Out of scope

- Third-party services: payment providers (Stripe and others), WhatsApp and email providers, Cloudflare, the cloud and DNS providers, unless our configuration is what makes them exploitable.
- Denial of service and volumetric testing of any kind. A cheap amplification may be reported; do not run it at scale.
- Social engineering of staff, customers or end users; physical attacks.
- Data that is not yours: other users' tenants and data, and the data of any tenant we run for a customer. Test only against your own tenant and accounts (see "Safe harbour").
- Findings in a tenant's own application code, unless the platform is what makes them exploitable.
- Reports from automated scanners without a demonstrated impact; missing headers or best practices with no impact; self-XSS; clickjacking of pages with no state-changing action.
- Known and accepted residual risks listed in `docs/24-threat-model.md` (for example the `code/` hygiene residual in "Secrets in logs, errors, bundle, responses").
- Anything already reported, or already tracked as a `security` issue.

## Severity

Levels follow the incident runbook (critical = SEV1, high = SEV2, medium = SEV3, low = SEV4). The rows are the guide, not a table of fixed answers: the reviewer rates by demonstrated impact, and a chain of findings is rated by its end.

| Severity | Meaning | Examples (threat-model section) | Fix target |
| --- | --- | --- | --- |
| Critical | Confirmed cross-tenant access, an escape from the sandbox, a platform key exposed, or operator rights | Tenant to tenant data read (C, "Reading another tenant's data"); isolate or process-tier escape (B, "Isolate escape"); a secrets master key or token signing key obtained (G, "Key compromise"); reaching `ops:*` without an operator account (E) | 7 days |
| High | A control is broken and exploitable, with no cross-tenant read shown | IDOR in the control-plane API (E); SSRF filter or DNS-pinning bypass in tenant `fetch` (B); SQLite authorizer bypass (B, D); account takeover of a developer (E); custom domain takeover (C); a module reading another module's tables or undeclared secrets (D); a secret in a log, error, bundle or response (B) | 30 days |
| Medium | Limited reach or needing unlikely conditions | Stored XSS in an official module or the dashboard (A, E); CSRF on a state-changing action (A); open redirect through an official helper (A); a limit that can be exceeded without hurting others (B); a role or policy broader than intended (A, E) | next phase |
| Low | Hardening, defence in depth, informational | Timing difference in a non-secret compare; information disclosure with no sensitive data; a header gap with a demonstrated, small impact (A) | backlog |

An XSS that reaches another tenant's data, or one in the dashboard that takes over an account, is rated high or critical by its effect, not by its class.

## Rewards

To be set at launch. This draft fixes the structure (the four levels above), not the amounts. The owner decides the budget, the currency, the payment channel and whether low findings get credit only. Reporters are credited in the advisory unless they ask otherwise.

## Rules

- Test only against your own tenant and your own accounts, or data you created for the purpose. Do not access, keep, copy or share data that is not yours; if you reach some, stop, report it, and say what you accessed.
- No denial of service, no automated high-volume traffic, no scanning of hosts that are not listed above, no testing of the operator console or of staff accounts.
- Do not pivot from a finding into a third-party system.
- One report per issue; include the affected host or component, steps to reproduce, evidence, and the impact you demonstrated. A proof of concept that stays inside your own tenant is the most useful kind.
- Give us a reasonable time to fix before you publish; we publish an advisory after the fix is deployed (`SECURITY.md`, "What to expect").
- The first valid report of an issue is the one rewarded; a duplicate is thanked.

## Safe harbour

If you act in good faith under this scope and `SECURITY.md`, we will not pursue or support legal action against you, will not ask a provider to suspend your accounts for the research, and will tell any third party that asks that your research was authorised. This covers the targets in "In scope" only. Good faith means you follow "Rules" above. If in doubt whether something is allowed, ask at security@renoxium.com before you test.

## Reporting

- Email **security@renoxium.com**. The mailbox is routed to the on-call rotation (`ops/security/incident-runbook.md`, "On call").
- Or, where private vulnerability reporting is enabled on the repository, open a report through GitHub's "Report a vulnerability".
- Do not open a public issue, pull request or discussion for a vulnerability.
- Write in English or Arabic.
- Targets: acknowledgement within 2 business days, a first assessment within 5 (`SECURITY.md`, "What to expect").

## Before publishing (owner steps)

1. The first external user is on the free tier (gate F7, #86).
2. Set the rewards, the budget and the payment channel; decide the payout rules.
3. Confirm `security@renoxium.com` and the `security.txt` files are live (`SECURITY.md`).
4. Replace "DRAFT" above, publish the page (for example at `renoxium.com/security`), and update the "Bug bounty" section of `SECURITY.md`.
5. Tell the on-call rotation: reports now arrive with a payout attached, and duplicates and triage need a named owner.
