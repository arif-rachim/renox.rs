# Incident response runbook

For security incidents on the Renox platform: a tenant or outsider reading or changing what is not theirs, a leaked secret or key, an escaped isolate, an abused operator account, a compromised node or dependency. Outages without a security cause follow the failure-mode table (`docs/23-failure-modes.md`) instead; if in doubt, open an incident here and downgrade later.

Owner of this document: the security lead (see "On call"). Reviewed after every incident and at each phase gate.

## On call

- `security@renox.app` and GitHub private vulnerability reports go to the on-call rotation: one primary, one secondary, weekly hand-over. The rotation and the phone numbers live in the operations password manager, not in this repository.
- The primary acknowledges a page within 15 minutes, day or night, for SEV1 and SEV2; within one business day for SEV3 and SEV4.
- Anyone who suspects an incident pages the primary. Nobody waits for certainty.

## Severity

| Level | Meaning | Examples | Response |
| --- | --- | --- | --- |
| SEV1 | Confirmed cross-tenant access, an escape from the sandbox, a platform key or master secret exposed, or an attacker with operator rights | Isolate escape; one tenant's SQLite read by another; secrets master key in a log; operator account taken over | All hands; incident lead named at once; status page within 1 hour; regulator assessment within 24 hours |
| SEV2 | A control is broken and exploitable, no confirmed abuse yet; or one tenant's data exposed by a platform fault | SSRF filter bypass; authorizer bypass; a tenant secret in that tenant's own logs; a takeover of one custom domain | Incident lead and one engineer; fix or mitigation within 24 hours |
| SEV3 | A weakness with limited reach or needing unlikely conditions | Timing side channel in a non-secret compare; a limit that can be exceeded by a factor without affecting others | Normal work, tracked as a `security` issue; fix within 30 days |
| SEV4 | Hardening, defence in depth, informational reports | Missing header with no impact | Next phase |

Pentest and disclosure findings use the same levels (`ops/security/pentest-scope.md`, "Severity and SLA").

## The first 30 minutes: contain

The incident lead writes every action with its time into the incident document (template below) as it happens. Contain first, investigate second; prefer actions that can be undone.

| Situation | Action | How |
| --- | --- | --- |
| A tenant is the attacker, or a tenant's app is being abused | Suspend the tenant: its hostnames stop serving, its tokens stop working | `POST /v1/admin/tenants/{tenant_id}/suspend` (`suspendTenant`, operator token); reinstated with `POST /v1/admin/tenants/{tenant_id}/reinstate` (`reinstateTenant`) |
| A tenant token or session is leaked | Revoke it; for a session, sign out everywhere | `DELETE /v1/tokens/{token_id}` (`revokeToken`); the account's "sign out everywhere" (`control/api/README.md`, "Account endpoints") |
| A tenant secret is leaked | The tenant rotates it; we tell them which one and since when | `PUT /v1/apps/{app}/secrets/{name}` (new secret-set version, cells pick it up on the next cold start) |
| A platform key is exposed (TLS, token signing, cookie signing, secrets master key, backup key, registry key) | Rotate it with its runbook | `ops/security/keys.md` (#120), one runbook per key |
| A node is suspected compromised | Take it out of placement, move its tenants, keep the disk | Mark the node not schedulable, `moveTenant` each tenant (deploy API section 17), then power off without wiping; a snapshot of the disk before anything else touches it |
| An address or range is attacking | Block it at the edge | Cloud firewall / gateway per-IP limits (`[gateway] rate_limit_per_ip`, `max_connections_per_ip` in `worker.toml`) |
| An operator account is suspected compromised | Disable it at the operator identity provider, revoke its `renox_op_` tokens, review its audit rows | `ops/security/access-review.md`, "Off-boarding" steps, then the audit query below |
| A dependency is compromised (supply chain) | Pin to the last known-good version, rebuild, redeploy workers and control plane | `deny.toml`, `Cargo.lock`, `bun.lock`; the release workflow |

## Evidence preservation

Before changing anything that holds evidence, copy it. Evidence goes to the incident bucket (write-once, object lock for 1 year), never to a laptop.

- **Audit log.** Export the audit rows of the affected tenants and of every operator for the window: `select * from audit where (tenant_id = any($1) or actor like 'operator%') and at between $2 and $3 order by at` against the control-plane Postgres (read replica), as CSV with a SHA-256 next to it.
- **Tenant logs** for the window (`GET /v1/apps/{app}/logs`, or the log store directly), and the meter records.
- **Node.** A disk snapshot of the node (cloud snapshot, or `dd` of the volume for colocation), the worker's own log (journald), `/healthz` output, the route table snapshot (`<data_dir>/routes.snapshot.json`).
- **Tenant files.** Never edit a tenant's `app.db` in place. Copy it, or restore a point in time next to it (`renox db restore --at <time> --as <new-app>`, deploy API section 14).
- Record who collected what, when, and the hash of each file (chain of custody).

## Communication

| Who | When | Through | Who sends |
| --- | --- | --- | --- |
| Internal: on call, founders | At once | Incident channel | Incident lead |
| Status page | SEV1 within 1 hour, SEV2 within 4 hours, if customers are or may be affected | Status page | Incident lead |
| Affected tenants (owner and admins) | As soon as the facts are confirmed, at the latest within 72 hours for SEV1 and SEV2 | Email from `security@renox.app`; dashboard banner | Incident lead, reviewed by a second person |
| Data protection authority | Within the window the applicable law sets for a personal-data breach, after a documented assessment | The authority's breach notification channel | Founder responsible for compliance |
| Reporter (if the incident came from a report) | At acknowledgement, at fix, at disclosure | Reply to the report | On call |

**PDPL and the authority.** Tenants established in the UAE mainland fall under the Federal PDPL (Decree-Law 45/2021); tenants in DIFC or ADGM fall under those regimes (`docs/21-uae-gcc-strategy.md`, "Data protection"). The exact notification window, the authority's contact and the form are **to verify** with counsel before external customers (the "items to verify" list of `docs/21`); until then, notify affected tenants within 72 hours and assess regulator notification within 24 hours of confirming a breach of personal data. Record the assessment and its reason either way.

Messages never include another tenant's name or data, a secret value, or an unfixed attack path.

## After the incident

1. Close containment: reinstate what was suspended once safe, rotate whatever was exposed even if containment held.
2. Post-mortem within 5 business days, blameless, using the template below.
3. Every action item becomes a GitHub issue with the `security` label and a severity; SEV1 and SEV2 items are due before the next phase gate.
4. Update `docs/24-threat-model.md` (a missing row or test) and `docs/23-failure-modes.md` if the incident showed a gap.

## Templates

### Incident document

```
Incident <YYYY-MM-DD>-<n>        Severity: SEVx        Lead: <name>
Detected: <time, by whom, how>
Timeline (UTC):
  <time>  <what happened / what we did / who>
Affected: tenants <ids>, hosts <list>, data <classes>, window <from–to>
Containment: <actions, each with its time>
Evidence: <item, location, sha256, collected by>
Communication: <who was told what, when>
Open questions:
```

### Post-mortem

```
Summary (three sentences):
Impact: who, what data, how long
Root cause: the technical cause, and why our controls did not stop it
Detection: how we found out; how we could have found out sooner
What went well / what went badly
Action items: <issue link> <owner> <due>
```

## Tabletop exercise

A tabletop is run with at least two people before external customers, and after each change of the on-call rotation's members. The facilitator picks a scenario, the participants walk through this runbook out loud, and every gap found becomes an issue.

Scenarios to rotate through:

1. A researcher reports that `fetch("http://[::ffff:169.254.169.254]/")` from a tenant returns cloud metadata.
2. A tenant's `renox_pat_` token appears in a public GitHub repository and was used from an unknown address an hour ago.
3. A worker node shows an unknown process and outbound traffic to an unfamiliar host.
4. An operator reports their laptop stolen while signed in to the operator console.

| Date | Scenario | Participants | Gaps found (issues) |
| --- | --- | --- | --- |
| _not run yet_ | | | |

The first exercise is an owner step of #121; its row and its issues are added here when it has run.
