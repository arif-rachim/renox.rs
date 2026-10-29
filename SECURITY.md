# Security policy

Renox runs other people's code next to other people's data. We want to hear about every weakness that lets one tenant, end user, module publisher or outsider read, change or disrupt what is not theirs.

## Reporting a vulnerability

- Email **security@renox.app**. The mailbox is routed to the on-call rotation (`ops/security/incident-runbook.md`, "On call").
- Or, where private vulnerability reporting is enabled on this repository, open a report through GitHub's "Report a vulnerability".
- Please do **not** open a public issue, pull request or discussion for a vulnerability.
- Write in English or Arabic. Include what you did, what you saw, the affected host or component, and how to reproduce it. A proof of concept that stays inside your own tenant is the most useful kind.

The machine-readable version of this page is served at `https://renox.app/.well-known/security.txt` (RFC 9116) by the gateway (`crates/renox-gateway/src/well_known.rs`).

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement of your report | 2 business days |
| First assessment (accepted, need more information, or out of scope) | 5 business days |
| Fix of a critical finding | 7 days after acceptance |
| Fix of a high finding | 30 days after acceptance |
| Fix of a medium or low finding | the next phase |
| Public advisory | after the fix is deployed, credited to you unless you ask otherwise |

These are targets, not guarantees; we tell you when we will miss one and why. Severity follows `ops/security/incident-runbook.md`, "Severity".

## In scope

- The data plane: the gateway, the runtime and its isolates, the per-tenant SQLite files and their authorizer, templates, the worker (`crates/`).
- The control plane: the deploy API, the dashboard, billing, the operator console (`control/`).
- The `renox` CLI and SDK (`cli/`, `sdk/`), the official modules (`modules/`), the platform MCP and the per-app MCP endpoint.
- `*.renox.app` hosts we operate, and custom domains as far as Renox serves them.

Examples of what we care about most: escaping an isolate or a process tier; reading or writing another tenant's data; reaching private or metadata addresses through tenant `fetch`; a module reading a table outside its prefix; a secret appearing in a log, error, bundle or response; taking over a custom domain or an account; bypassing a per-tenant limit in a way that hurts other tenants.

## Out of scope

- Denial of service by volume (floods, load tests) against hosts we operate. Report a cheap amplification instead; do not run it at scale.
- Social engineering of staff, customers or end users; physical attacks.
- Findings in a tenant's own application code (report those to the tenant), unless the platform is what makes them exploitable.
- Missing headers or best practices with no demonstrated impact; self-XSS; clickjacking of pages without state-changing actions; reports from automated scanners without a verified impact.
- Vulnerabilities in third-party services we use, unless our configuration is what makes them exploitable.

## Safe harbour

If you act in good faith under this policy, we will not pursue or support legal action against you, and we will tell any third party that asks that your research was authorised. Good faith means:

- you test only against your own tenant and accounts, or against data you created for the purpose;
- you stop and report as soon as you reach data that is not yours, you do not keep, copy or share it, and you tell us what you accessed;
- you do not degrade the service for others, do not use what you find beyond what demonstrates it, and give us a reasonable time to fix it before you publish.

If in doubt about whether something is allowed, ask at security@renox.app first.

## Bug bounty

There is no paid bounty programme yet; one is planned after the platform takes external customers (F7). We credit reporters in the advisory.
