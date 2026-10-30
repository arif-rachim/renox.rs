# Keys: inventory, custody, rotation

The platform's keys, where each lives, who can use it, and how it is rotated (#309; `docs/24-threat-model.md` G, "Key compromise" and "Tenant files or backups read from storage"). The infrastructure that holds the cloud keys is `ops/terraform/` (KMS keys and the export bucket). Every change to this file is a code-owner review (`ops/`).

## Inventory

| Key | Protects | Where it lives | Who can use it | Rotation |
| --- | --- | --- | --- | --- |
| Control-plane master key `CONTROL_MASTER_KEY` | Tenant secrets, certificate keys, the node callback tokens, the MCP OAuth seals, TOTP secrets (AES-256-GCM, keys derived with HKDF; `control/api/src/secrets/crypto.ts`) | The control API's environment, from the cloud secret store; never in Postgres, never in a log | The control API process; two named operators can read it from the secret store (break-glass, `ops/security/access-review.md`) | Yearly and on suspicion: procedure "Master key" below. Not yet in KMS: Open 1 |
| Page session key (`platform_key_file` of each worker) | The HMAC of page session cookies and CSRF tokens, one key per tenant derived with HKDF (`crates/renox-cell/src/pages/`) | A file readable by the `renox` user on each node, written by `ops/scripts/bootstrap-node.sh` | The worker process | On suspicion: replace the file on every node and restart; every page session ends (users sign in again) |
| API tokens (`renox_pat_`, `renox_op_`, `renox_node_`, `renox_cb_`) | Authentication to the deploy API and the node listener | Not keys: random values, stored as SHA-256 only (`docs/contracts/deploy-api.md` section 2); there is no token signing key | — | Per token: revoke (`revokeToken`), or a new node registration for `renox_cb_` |
| Backup KMS key `alias/renox-backup` | Litestream replicas (SSE-KMS, `[replication] sse_kms_key_id`) | AWS KMS, `ops/terraform/kms.tf`, automatic yearly rotation on | The workers' role (encrypt and decrypt), the restore runbook's role (decrypt) | Automatic (KMS keeps the old versions for decryption); drill "Backup key" below |
| Export KMS key `alias/renox-export` | Exports and database snapshots in the export bucket (SSE-KMS, `EXPORT_KMS_KEY_ID` of the control API) | AWS KMS, `ops/terraform/kms.tf`, automatic yearly rotation on | The control API's role (encrypt), signed URL downloads (decrypt through S3) | Automatic; exports expire after 7 days (lifecycle), so no old export outlives two rotations |
| Worker release signature | `renox-worker` release binaries | No long-lived key: cosign keyless signing with the release workflow's OIDC identity (`.github/workflows/release-worker.yml`) | The release workflow on a signed tag | Nothing to rotate; a new release is signed with a fresh certificate |
| TLS keys | `*.renox.app` and custom domains | Certificates and keys encrypted with the master key in Postgres (`control/api/src/domains/`), served to nodes on request | The control API, the gateway of each node (in memory) | Renewed 30 days before expiry (ACME); on suspicion, revoke at the CA and re-issue |

## Custody

- Cloud keys are KMS keys: their material never leaves KMS, and each one has a key policy that names the roles above and nothing else (`ops/terraform/kms.tf`). Deletion has a 30-day window.
- `CONTROL_MASTER_KEY` and the page session key are the two keys outside KMS. Each is generated on a trusted machine (`openssl rand -base64 32`), written once to the secret store or the node, and never sent over chat or email.
- A role change in the team (someone leaves, someone joins operations) is a custody review: the access review of `ops/security/access-review.md` lists who can read each key.

## Procedures

### Master key

1. Generate the new key and store it in the secret store as the next version.
2. Deploy the control API with `CONTROL_MASTER_KEY` set to the new key and `CONTROL_MASTER_KEY_PREVIOUS` to the old one (Open 2: the re-encryption job that reads with the previous key and writes with the new one is not built yet; until it is, a rotation needs a maintenance window in which every sealed value is re-encrypted by a script run against Postgres).
3. Verify: a secret round-trips (`renox secrets set` and a request that reads it), a certificate is served to a node, a TOTP code verifies.
4. Remove the previous version from the secret store; record the drill below.

### Backup key (drill)

1. In a staging account, call `aws kms rotate-key-on-demand --key-id alias/renox-backup`.
2. Write to a tenant with replication on, then restore it to a new app (`restoreBackup`) from a point before the rotation and from one after it.
3. Both restores pass `PRAGMA quick_check` and hold the expected rows; record the drill below.

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
