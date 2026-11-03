# src/domains — custom domains through Cloudflare for SaaS (#59, #419)

The contract is `docs/contracts/deploy-api.md` 0.6 section 10; the decision is ADR D25 (`docs/13-decisions.md`); the product rules are `docs/05-tenant-lifecycle.md`, "Custom domains and DNS".

Every custom domain, the platform's own included (`renoxium.com`, `www.renoxium.com` and `dashboard.renoxium.com`, attached to the platform tenant through the same `addDomain` path, #396), is a **custom hostname** on the platform domain's Cloudflare zone. Cloudflare proves ownership with its pre-validation TXT record, validates and issues the edge certificate (DCV by TXT), renews it, and sends the traffic through the tunnel's fallback origin, the zone apex `renoxium.app` (ADR D26), to the worker. The control API orders no certificate, stores no key and runs no DNS lookups; nodes receive no certificate.

| File | What |
| --- | --- |
| `routes.ts` | `POST/GET /v1/apps/{app}/domains`, `GET/DELETE …/{hostname}` |
| `cloudflare.ts` | The `CustomHostnames` interface and its client (create, get, delete) for `zones/{zone}/custom_hostnames` |
| `service.ts` | The per-process client from `CONTROL_CF_*`; `configureDomains` replaces it in tests (`StubCloudflare`, `tests/domain-stubs.ts`) |
| `repo.ts` | Domain rows (with the custom hostname's id and last status), the `Domain` view, the route entries of verified domains |
| `jobs.ts` | The domain job: the pending poll, the re-checks, custom hostnames for rows that lack one, releases, the route mirror |
| `ownership.ts` | One owner per hostname, the 30-day hold of a detached claim, the custom hostname's creation and deletion (#114) |
| `reverify.ts` | The status poll of verified and detached domains; detach only after consecutive misses over a grace period (#398) |

## Lifecycle

1. **Add.** `POST /v1/apps/{app}/domains {hostname}` claims the hostname (`pending`) and creates its custom hostname at Cloudflare (DV certificate, TXT validation, TLS 1.2 minimum). The answer carries `cname_target` (the fallback origin), Cloudflare's `status` and `ssl_status`, and `verification`: Cloudflare's ownership TXT (`purpose: ownership`) and the certificate's DCV TXT (`purpose: dcv`). A hostname of the platform domain is refused with 400; a hostname another claim holds (any state but `released`) gets 409 `not available`, without naming the holder. Without `CONTROL_CF_*` the answer is 503 `RENOX_UNAVAILABLE` and nothing is claimed; when Cloudflare refuses or does not answer, a new claim is withdrawn and the answer is 503 too.
2. **Verify.** The job reads the custom hostname every minute (`PENDING_POLL_MS`). Cloudflare's `active` (the ownership TXT found and the CNAME reaching the zone) moves the claim to `verified`. Before that the hostname has no route entry, so every node answers 404 for it (failure mode "Unverified custom domain").
3. **Serve.** A verified hostname's route entries mirror those of `<app>.<platform domain>`: same deployment, status, node, tier and secret version. The mirror is recomputed after every domain change and on every job tick, so an activation or a rollback reaches custom domains within one tick (5 s in `main.ts`).
4. **Detach.** `DELETE` moves `verified` to `detached` (entries removed; the custom hostname is kept for the hold) and `pending` or `detached` to `released` (the custom hostname is deleted at Cloudflare; a failed delete is retried by the job). A released hostname can be claimed again.

**Apex domains.** There is no node address to give (the origin is hidden behind the tunnel). Customers use `www.<their domain>` and redirect the apex to it at their DNS provider or registrar, or use CNAME flattening where their DNS provider offers it.

## Ownership (#114)

`docs/24-threat-model.md` section C, "Custom domain takeover":

- **One owner.** A hostname has at most one claim in any state but `released` (unique index `domains_one_owner`), and a custom hostname belongs to one row (unique index `domains_cf_hostname_id`). Of two tenants racing for one hostname exactly one wins; the other gets 409 `not available`, without the owner's name, and Cloudflare is not asked.
- **Hold.** A detached claim stays owned for 30 days (`HOLD_MS`), then the job releases it and deletes its custom hostname. Its owner can add it again, which re-checks it, or `DELETE` it again, which releases it at once.
- **Status poll.** A verified domain's custom hostname is read every hour (`REVERIFY_MS`). `active` is a match. `moved` (the customer's CNAME no longer reaches us), `deleted`, `blocked`, their pending forms and "not found" are misses. One miss never detaches: it is counted (`cf_misses`, `cf_first_miss_at`, migration `0029`) and read again after 15 minutes (`MISS_RECHECK_MS`); only the third consecutive miss (`DETACH_MISSES`) at least 30 minutes after the first (`DETACH_GRACE_MS`) detaches. Any match resets the count. An API error, a timeout, or any other status (for example `pending` while Cloudflare re-validates) is **unknown**: not a miss, nothing changes, retried within the hour (the lesson of #398, kept for the poll). A detached domain: serving stops, the tenant's owners and admins get a `domain_detached` email naming the status, and an audit row (`detachDomain`, actor `domain-job`) is written. It is read every hour; `active` moves it back to `verified` (`reverifyDomain`) and its entries return. **Forcing a re-check:** the owner's `POST /v1/apps/{app}/domains {hostname}` on their own detached claim answers 201 with the same custom hostname, moves the claim to `app`, and makes it due at once.
- **Slugs.** App names are the `<app>.renoxium.app` slugs (`src/apps/slugs.ts`). Reserved words are never app names, and a deleted app's name is quarantined for 90 days for every other tenant. Both are enforced by triggers on `apps`, so `createApp` answers 409 `not available`.
- **Erasure.** Erasing a tenant deletes its custom hostnames at Cloudflare before its domain rows (`src/tenants/erasure.ts`, step `records`); a failure keeps the step for the next retry.

## Configuration

Read by `loadConfig` (`src/config.ts`), all three or none; a refusal names the variable and never repeats the token:

| Variable | Meaning |
| --- | --- |
| `CONTROL_CF_API_TOKEN` | A Cloudflare API token with *Zone → SSL and Certificates → Edit* on the platform domain's zone only. Sent in the `Authorization` header; never logged |
| `CONTROL_CF_ZONE_ID` | The zone id (32 hex characters) of the platform domain (`renoxium.app`) |
| `CONTROL_CF_FALLBACK_ORIGIN` | The CNAME target of custom domains and the zone's fallback origin, the apex `renoxium.app` (the proxied CNAME to the tunnel; set as fallback origin in the Cloudflare dashboard; ADR D26) |
| `CONTROL_CF_API_URL` | Default `https://api.cloudflare.com/client/v4`; `http://` only to loopback |

Unset: `addDomain` answers 503 and the job creates nothing (local development and tests without a stub). The `_renox-verify` TXT record, the ACME settings (`CONTROL_ACME_*`), `CONTROL_EDGE_*` and `CONTROL_DNS_SERVERS` are gone (#419).

**Plan and price.** Cloudflare for SaaS on the zone's plan: the first 100 custom hostnames are included, then about $0.10 per hostname per month (the owner records the exact numbers from the dashboard in ADR D25 before enabling).

## Tests

`tests/domains.test.ts` (add, the 503s, the poll, the route mirror, remove, the client against a fake `fetch`, the configuration) and `tests/domains-ownership.test.ts` (one owner, the hold, the status poll and its miss rule) run against `StubCloudflare`. The test harness (`tests/helpers.ts`) configures a `StubCloudflare` for every test; no test calls Cloudflare.
