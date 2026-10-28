# src/domains — custom domains and certificates (#59)

The contract is `docs/contracts/deploy-api.md` section 10; the product rules are `docs/05-tenant-lifecycle.md`, "Custom domains and DNS".

| File | What |
| --- | --- |
| `routes.ts` | `POST/GET /v1/apps/{app}/domains`, `GET/DELETE …/{hostname}`, and the node's `GET /v1/nodes/{node_id}/certificates/{hostname}` |
| `repo.ts` | Domain rows and views; the route entries of verified domains |
| `jobs.ts` | The domain job: TXT verification, DNS checks, certificate orders and renewal |
| `ownership.ts` | One owner per hostname, the 30-day hold of a detached claim, stop and resume serving (#114) |
| `reverify.ts` | The TXT re-check every 7 days and before every order (#114) |
| `dns.ts` | The resolver interface, the TXT check, the "points at the edge" check |
| `acme.ts` | A minimal ACME client (RFC 8555, HTTP-01, ES256 account key) |
| `csr.ts` | Certificate keys (P-256) and the PKCS#10 request |
| `challenges.ts` | Where HTTP-01 key authorizations go (a directory the workers serve) |
| `certs.ts` | Certificates and the ACME account key at rest, encrypted with the platform data key |
| `service.ts` | The per-process parts (resolver, ACME client, responder, edge, keys) and the certificate messages to nodes |

## Lifecycle

1. **Add.** `POST /v1/apps/{app}/domains {hostname}` creates a `pending` claim and returns the TXT record: `_renox-verify.<hostname>` = `rnx-verify-<26 random base32 characters>`. A hostname of the platform domain (`*.renox.app`) is refused with 400; a hostname another claim holds (any state but `released`) gets 409 `not available`, without naming the holder.
2. **Verify.** The job looks the TXT record up every minute (`PENDING_POLL_MS`). A match moves the claim to `verified`. Before that, the hostname has no route entry and no certificate, so every node answers 404 for it (failure mode "Unverified custom domain").
3. **Serve.** A verified hostname's route entries mirror those of `<app>.<platform domain>`: same deployment, status, node, tier and secret version. The mirror is recomputed after every domain change and on every job tick, so an activation or a rollback reaches custom domains within one tick (5 s in `main.ts`).
4. **Point.** Every hour (`DNS_CHECK_MS`) the job checks that the hostname reaches the edge: a CNAME to the edge hostname, or A/AAAA records that are all edge addresses. `dns` is `pending` until the first success, then `ok` or `not_pointing` (the "stopped pointing at Renox" flag). A failed lookup changes nothing.
5. **Certificate.** A verified domain whose `dns` is `ok` and that has no certificate, or one that expires within 30 days (`RENEW_BEFORE_MS`), gets an ACME order: HTTP-01, the key authorization written to the challenge directory, the worker's `:80` listener (#162) answering it. Renewal is paused while `dns` is not `ok`. A failed order is retried after 1 h, doubled per failure, at most 24 h; a domain that already has a certificate keeps serving it. The certificate is stored encrypted and every node gets `certificate_update` (hostname, version, `not_after`) on its stream; the node fetches the chain and key from `GET /v1/nodes/{node_id}/certificates/{hostname}` (`Cache-Control: no-store`), writes `<cert_dir>/<hostname>/{fullchain,privkey}.pem`, and reloads.
6. **Detach.** `DELETE` moves `verified` to `detached` (entries removed, `certificate_remove` to every node) and `pending` or `detached` to `released` (the stored certificate is deleted). A released hostname can be claimed again.

## Ownership (#114)

`docs/24-threat-model.md` section C, "Custom domain takeover":

- **One owner.** A hostname has at most one claim in any state but `released` (unique index `domains_one_owner`). Of two tenants racing for one hostname exactly one wins; the other gets 409 `not available`, without the owner's name.
- **Hold.** A detached claim stays owned for 30 days (`HOLD_MS`), then the job releases it and deletes its certificate. Within the hold, a hostname whose CNAME still points at Renox cannot be claimed by another tenant. Its owner can add it again, which re-verifies it, or `DELETE` it again, which releases it at once.
- **Re-verification.** The TXT record is checked again every 7 days (`REVERIFY_MS`) and before every certificate order. If it is missing, the domain moves `verified` → `detached`: serving stops, the tenant's owners and admins get a `domain_detached` email, and an audit row (`detachDomain`, actor `domain-job`) is written. While it is detached for that reason, the record is checked every hour. When the record is back, the domain moves → `verified` (`reverifyDomain`), its entries return, and the stored certificate is announced again under a new version. A failed lookup is not a missing record.
- **Slugs.** App names are the `<app>.renox.app` slugs (`src/apps/slugs.ts`). Reserved words are never app names, and a deleted app's name is quarantined for 90 days for every other tenant. Both are enforced by triggers on `apps`, so `createApp` answers 409 `not available`.
- **Public Suffix List.** `ops/psl/README.md` has the submission checklist and the interim cookie rules.

Versions of `certificate_update` and `certificate_remove` come from one sequence for all hostnames, so a node can order any two messages about one hostname, also across a release and a new claim.

## At rest

Chains, keys and the ACME account key are encrypted with AES-256-GCM under the platform's data key, which is wrapped by the master key like a tenant's (`deploy-api.md` section 9) under the key id `_platform` (no tenant id can start with `_`). The associated data binds each ciphertext to its hostname and version, or to its ACME directory. Keys are never logged and never travel on the node stream.

## Configuration

Read by `startDomainJobs` in `main.ts`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTROL_ACME_DIRECTORY_URL` | unset: no certificates are ordered | e.g. `https://acme-staging-v02.api.letsencrypt.org/directory`, then production |
| `CONTROL_ACME_CHALLENGE_DIR` | unset: no certificates are ordered | The directory the workers serve as `[tls] acme_dir` |
| `CONTROL_ACME_EMAIL` | unset | ACME account contact |
| `CONTROL_ACME_CA_FILE` | unset | Extra CA (PEM) for the ACME server's own TLS (Pebble) |
| `CONTROL_EDGE_HOSTNAME` | `edge.<CONTROL_PLATFORM_DOMAIN>` | The CNAME target tenants use |
| `CONTROL_EDGE_ADDRESSES` | empty | Comma-separated A/AAAA addresses an apex may point at |
| `CONTROL_DNS_SERVERS` | the system's | Comma-separated `ip` or `ip:port` for the DNS checks |

`CONTROL_MASTER_KEY` is needed too: without it certificates can be neither stored nor served (the node endpoint answers 503).

## Limits of this version

- **Challenge distribution.** HTTP-01 is answered by whichever node the CA reaches, from that node's `acme_dir`. `DirChallengeResponder` writes into one directory, so the control plane and the workers must share it (one host, or a shared volume). Several hosts need the key authorization on every node: a control message or an endpoint the node falls back to; neither is in the contract yet.
- **Node side.** Fetching bundles on `certificate_update`, writing `cert_dir` and reloading is the node's control client (#55). A node that was offline learns current certificates by fetching the bundle of every custom hostname of its route snapshot; the contract has no certificate snapshot.
- **No wildcard domains.** The contract's `Hostname` pattern has no `*.` form, and wildcards need DNS-01 (`docs/05-tenant-lifecycle.md`). So the "most specific claim wins" rule between a wildcard and a subdomain (#114) has nothing to apply to yet.

## Tests

`tests/domains.test.ts` runs every step with a stub resolver and a stub issuer. `tests/domains-e2e.test.ts` runs the whole path against Pebble (Let's Encrypt's ACME test server), `pebble-challtestsrv` as the DNS server, and two `renox-worker` processes; it is skipped unless both are present:

```sh
mkdir -p /tmp/pebble && cd /tmp/pebble
for f in pebble pebble-challtestsrv; do
  curl -sSL https://github.com/letsencrypt/pebble/releases/download/v2.7.0/$f-linux-amd64.tar.gz | tar xz --strip-components=3 $f-linux-amd64/linux/amd64/$f
done
chmod +x pebble pebble-challtestsrv
cd -
RENOX_PEBBLE_DIR=/tmp/pebble RENOX_WORKER_PATH=$PWD/target/debug/renox-worker bun test tests/domains-e2e.test.ts
```
