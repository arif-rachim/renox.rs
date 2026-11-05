# Keys: inventory, custody, rotation

The platform's keys, where each lives, who can use it, and how it is rotated (#309; `docs/24-threat-model.md` G, "Key compromise" and "Tenant files or backups read from storage"). The infrastructure that holds the cloud keys is `ops/terraform/` (KMS keys and the export bucket). Every change to this file is a code-owner review (`ops/`).

## Inventory

| Key | Protects | Where it lives | Who can use it | Rotation |
| --- | --- | --- | --- | --- |
| Control-plane master key `CONTROL_MASTER_KEY` | Tenant secrets, the node callback tokens, the MCP OAuth seals, TOTP secrets (AES-256-GCM, keys derived with HKDF; `control/api/src/secrets/crypto.ts`) | The control API's environment, from the cloud secret store; never in Postgres, never in a log. On the single host (`ops/single-host.md`) there is no secret store: see "Single host" below | The control API process; two named operators can read it from the secret store (break-glass, `ops/security/access-review.md`) | Yearly and on suspicion: procedure "Master key" below (two keys during a rotation, `CONTROL_MASTER_KEY_PREVIOUS`, and the re-seal job of #451). Not yet in KMS: Open 1 |
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

The control API holds two master keys during a rotation (#451, `control/api/src/secrets/master.ts`): `CONTROL_MASTER_KEY`, the current one, and `CONTROL_MASTER_KEY_PREVIOUS`, the one being retired. Every stored sealed value records the id of the key that sealed it (`mk-` and 16 hex characters of the key's SHA-256; the key itself is never stored): tenant data keys (`tenant_keys.master_key_id`), TOTP secrets (`account_mfa_totp.secret_key_id`) and node callback tokens (`workers.callback_token_key_id`). New values are sealed under the current key; a value opens with the key its id names. A value from before ids (`env-1`, or no id) tries the current key, then the previous one; AES-GCM refuses a wrong key, so nothing is guessed. MCP seals and signed export URLs are not stored: while the previous key is set they open under either key, and they expire on their own (at most 15 minutes for an export URL).

The re-seal job (`control/api/src/secrets/reseal.ts`) seals every value still under another key again under the current key, in batches, with one guarded write per row, so a crash in the middle loses nothing and the next run finishes. The control API runs it at start and hourly; `bun control/api/scripts/reseal.ts` runs it now. It logs counts only (the `reseal` log line); a value, a key or a ciphertext never appears in a log, an error or its report. How many values remain under another key is `renox_cp_sealed_values_other_key{kind}` on `GET /v1/ops/metrics` (kinds `tenant_key`, `totp`, `callback_token`).

The control API refuses to start (exit 78) when `CONTROL_MASTER_KEY_PREVIOUS` is set without `CONTROL_MASTER_KEY`, is the same key, or is not 32 bytes. The message names the variable, never the value.

1. **Generate** the new key on a trusted machine (`openssl rand -base64 32`). Store it as the next version in the secret store; on the single host, in the owner's password manager and the offline copy first (see "Single host"), before it is used anywhere.
2. **Deploy with both keys.** Set `CONTROL_MASTER_KEY` to the new key and `CONTROL_MASTER_KEY_PREVIOUS` to the old one (on the single host: edit `/etc/renox/control.env`, root 0600), then restart the control API (`systemctl restart renox-control`). Every value still opens; new values are sealed under the new key.
3. **Re-seal.** The API starts the job at start. To run it now and see the result, with the API's environment so no key is on a command line:

   ```bash
   sudo systemd-run --pipe --wait --property=EnvironmentFile=/etc/renox/control.env --property=WorkingDirectory=/opt/renox/src/control/api /opt/renox/bin/bun /opt/renox/src/control/api/scripts/reseal.ts
   ```

   It prints one JSON line (`"reseal": "done"`, `"remaining": 0`) and exits 0. Exit 1 means values remain: run it again; a row listed under `unreadable` opens under neither key (named by its tenant, user or node id only) and is an incident (`ops/security/incident-runbook.md`). Exit 78: the configuration is refused or the database is older than migration 0032.
4. **Check.** `renox_cp_sealed_values_other_key` is 0 for every kind. A secret round-trips (`renox secrets set`, then a request that reads it), a TOTP code verifies, and the dashboard's operator console reaches a node listener.
5. **Retire the old key.** Remove `CONTROL_MASTER_KEY_PREVIOUS` from the environment and restart the control API. Only then delete the old key from the secret store (on the single host: the password manager and the offline copy). Record the drill below.

If the old key is believed compromised, rotate the same way and as soon as possible, and treat it as an incident (`ops/security/incident-runbook.md`): the re-seal makes the stored values unreadable with the old key, but a value read while it was compromised (a tenant secret, a TOTP secret) must be rotated by its owner.

### Replica restore (drill)

`ops/single-host.md`, "Tenant files to R2": delete a test tenant's `app.db` on the node and restore it from `renoxium-replicas`; it passes `PRAGMA quick_check` and holds the expected rows. Record the drill below.

### Page session key

1. Write the new file on each node with `bootstrap-node.sh --rotate-platform-key` (Open 2) or by hand (`install -m 0400 -o renox`).
2. Restart the workers one by one; page sessions of that node's tenants end.

## Drill record

| Date | Key | Who | What was checked | Result |
| --- | --- | --- | --- | --- |
| | | | | |

The drills are owner steps (#309: "the drills themselves (owner)").

## Open

1. The master key in KMS (envelope encryption with a KMS data key) instead of the environment: the secondary control of `docs/24` G, "Key compromise".
2. `bootstrap-node.sh --rotate-platform-key`.
