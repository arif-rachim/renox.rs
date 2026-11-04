# Keys: inventory, custody, rotation

The platform's keys, where each lives, who can use it, and how it is rotated (#309; `docs/24-threat-model.md` G, "Key compromise" and "Tenant files or backups read from storage"). The infrastructure that holds the cloud keys is `ops/terraform/` (KMS keys and the export bucket). Every change to this file is a code-owner review (`ops/`).

## Inventory

| Key | Protects | Where it lives | Who can use it | Rotation |
| --- | --- | --- | --- | --- |
| Control-plane master key `CONTROL_MASTER_KEY` | Tenant secrets, the node callback tokens, the MCP OAuth seals, TOTP secrets (AES-256-GCM, keys derived with HKDF; `control/api/src/secrets/crypto.ts`) | The control API's environment, from the cloud secret store; never in Postgres, never in a log. On the single host (`ops/single-host.md`) there is no secret store: see "Single host" below | The control API process; two named operators can read it from the secret store (break-glass, `ops/security/access-review.md`) | Yearly and on suspicion: procedure "Master key" below. Not yet in KMS: Open 1 |
| Control-database backup key (age, single host) | The nightly `pg_dump` of the control database on R2 (`ops/scripts/backup-control-db.sh`) | Private key: the owner's password manager plus an offline copy, never on the host. Public key: `/etc/renox/backup-age.pub` | The owner, for a restore (`ops/single-host.md`, "Restore drill") | On suspicion or when the owner changes: a new pair, the new public key on the host; keep the old private key until the last backup encrypted to it expires (30 days) |
| Page session key (`platform_key_file` of each worker) | The HMAC of page session cookies and CSRF tokens, one key per tenant derived with HKDF (`crates/renox-cell/src/pages/`) | `/etc/renox/platform.key`, renox:renox 0400 on each node (the worker refuses group or other bits), written by `ops/scripts/bootstrap-node.sh` | The worker process | On suspicion: replace the file on every node and restart; every page session ends (users sign in again) |
| API tokens (`renox_pat_`, `renox_op_`, `renox_node_`, `renox_cb_`) | Authentication to the deploy API and the node listener | Not keys: random values, stored as SHA-256 only (`docs/contracts/deploy-api.md` section 2); there is no token signing key | — | Per token: revoke (`revokeToken`), or a new node registration for `renox_cb_` |
| R2 replica token (`renoxium-replicas`) | Litestream replicas of tenant files on Cloudflare R2 (#417, ADR D25), and the worker's replica purge and restore | `/etc/renox/secrets/r2-replica.env` (root, 0600), read by systemd into `renox-litestream@` and `renox-worker` (`EnvironmentFile=`); its own R2 API token with *Object Read & Write* on the `renoxium-replicas` bucket only | Litestream sidecars, the worker | On suspicion or yearly: a new R2 token, the file replaced, both units restarted; the old token revoked in the Cloudflare dashboard. R2 encrypts every object at rest with keys Cloudflare holds; there is no SSE-KMS key of ours |
| Export KMS key (optional) | Exports in an AWS bucket with SSE-KMS, `EXPORT_KMS_KEY_ID` of the control API | Only where the export store is AWS S3; on R2 (the single host) none: exports are plain puts, encrypted at rest by R2, readable only through a 15-minute signed URL | The control API | Automatic in KMS where used |
| Worker release signature | `renox-worker` release binaries | No long-lived key: cosign keyless signing with the release workflow's OIDC identity (`.github/workflows/release-worker.yml`) | The release workflow on a signed tag | Nothing to rotate; a new release is signed with a fresh certificate |

## Custody

- Object storage is Cloudflare R2 (ADR D25): encryption at rest is R2's own; the platform's custody is the scoped R2 tokens above, one per bucket. `ops/terraform` (AWS KMS) was removed with the residency rule (#417).
- `CONTROL_MASTER_KEY` and the page session key are the platform's own keys. Each is generated on a trusted machine (`openssl rand -base64 32`), written once to the secret store or the node, and never sent over chat or email.
- A role change in the team (someone leaves, someone joins operations) is a custody review: the access review of `ops/security/access-review.md` lists who can read each key.

### Single host

The single host (`ops/single-host.md`) has no cloud secret store and no KMS. There:

- `CONTROL_MASTER_KEY` lives in `/etc/renox/control.env` (root, 0600, read by systemd as root) and, outside the host, in **the owner's password manager plus an offline copy** (printed or on an encrypted USB key, kept somewhere other than the owner's workstation). Both copies are made when the key is generated, before the control API first starts; losing every copy loses every tenant secret and certificate key. It is never typed into a chat, a ticket, an issue or a PR.
- The age private key of the control-database backups (`age-keygen`, `ops/single-host.md` owner step 4) is kept the same way, next to the master key: the password manager plus the same offline copy, never on the host. Without it no backup can be restored; with it and the R2 keys, every backup can be read.
- The break-glass readers of the master key are the owner alone until a second operator exists; record that in the access review (`ops/security/access-review.md`).
- The page session key and the node token stay on the host (renox:renox 0400) and are not copied off it: a lost one is replaced (procedure "Page session key"; a new node token from `POST /v1/admin/nodes`).

## Procedures

### Master key

> **DO NOT RUN THIS PROCEDURE YET.** No code reads `CONTROL_MASTER_KEY_PREVIOUS` (audit of 2026-11-04, #450). Deploying the control API with a new `CONTROL_MASTER_KEY` makes every value sealed under the old key unreadable: every tenant secret, every TOTP secret, every other sealed column. Signing in with a second factor stops working and apps lose their secrets. The re-encryption job this procedure needs is #451 (`[F7-56]`). Until it is merged and this section is rewritten, keep the current key. If the key is believed compromised, treat it as an incident (`ops/security/incident-runbook.md`): rotate tenant secrets through their owners and reset second factors, not this key.

The procedure as it will work once #451 lands:

1. Generate the new key and store it in the secret store as the next version.
2. Deploy the control API with `CONTROL_MASTER_KEY` set to the new key and `CONTROL_MASTER_KEY_PREVIOUS` to the old one, then run the re-encryption job of #451 until it reports no value left under the previous key.
3. Verify: a secret round-trips (`renox secrets set` and a request that reads it), a TOTP code verifies.
4. Remove `CONTROL_MASTER_KEY_PREVIOUS` and the previous version from the secret store; record the drill below.

### Replica restore (drill)

`ops/single-host.md`, "Tenant files to R2": delete a test tenant's `app.db` on the node and restore it from `renoxium-replicas`; it passes `PRAGMA quick_check` and holds the expected rows. Record the drill below.

### Page session key

1. Write the new file on each node with `bootstrap-node.sh --rotate-platform-key` (Open 3) or by hand (`install -m 0400 -o renox`).
2. Restart the workers one by one; page sessions of that node's tenants end.

## Drill record

| Date | Key | Who | What was checked | Result |
| --- | --- | --- | --- | --- |
| | | | | |

The drills are owner steps (#309: "the drills themselves (owner)").

## Open

1. The master key in KMS (envelope encryption with a KMS data key) instead of the environment: the secondary control of `docs/24` G, "Key compromise".
2. A re-encryption job for the master key rotation.
3. `bootstrap-node.sh --rotate-platform-key`.
