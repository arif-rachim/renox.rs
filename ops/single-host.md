# Single host: Renoxium on one machine behind Cloudflare

The first production of Renoxium (#366) runs on one machine (`node-small`: 4 vCPU, 8 GB, Ubuntu 24.04, KVM VPS):

- the **worker** serves tenant apps on `<app>.renoxium.app`, and `renoxium.com`, `www.renoxium.com` and `dashboard.renoxium.com`, which are Renox apps attached as custom domains;
- the **control plane** (`control/api` on Bun, Postgres from the distribution) answers `api.renoxium.com` and `mcp.renoxium.com` through a **Cloudflare Tunnel**;
- backups go to **Cloudflare R2**.

This page takes an empty host to live. Every secret it names lives in a root-only file on the host or with the owner, never in this repository, an issue, a PR or a log line.

## What runs where

```
                  Cloudflare (DNS only)                    Cloudflare (tunnel, proxied)
   *.renoxium.app, renoxium.app, edge.renoxium.app        api.renoxium.com, mcp.renoxium.com
   renoxium.com, www, dashboard                                     │
              │ 80, 443                                             │ outbound from the host
              ▼                                                     ▼
 ┌──────────────────────────── node-small ─────────────────────────────────────┐
 │ nftables: inbound SSH (22 or --ssh-port), 80, 443 only                      │
 │                                                                             │
 │ renox-worker (0.0.0.0:443, :80)    renox-tunnel (cloudflared, DynamicUser)  │
 │   TLS, ACME HTTP-01, HTTP/2,          │                                     │
 │   per-IP limits on the socket         ▼                                     │
 │   address                         renox-control (Bun)                       │
 │        │                            public  127.0.0.1:8787  ◄── tunnel only │
 │        └── [control] url ─────────► node    127.0.0.1:8788  ◄── worker only │
 │                                         │                                   │
 │                                         ▼                                   │
 │                                   Postgres 127.0.0.1:5432                   │
 │ timers: renox-cert-renew (lego DNS-01), renox-backup-db (pg_dump → R2)      │
 └─────────────────────────────────────────────────────────────────────────────┘
```

- **No reverse proxy on the host.** The worker's gateway owns 443 and 80 and needs each socket's own address for its per-IP limits; nothing goes in front of it.
- **Client addresses.** On the app edge the worker reads the socket address, because every name it serves is DNS only, so clients connect directly. On the API edge every request arrives from `cloudflared` on loopback. `CONTROL_TRUSTED_PROXIES=127.0.0.1,::1` makes the API believe `CF-Connecting-IP` from those peers only (`control/api/src/auth/ip.ts`). Without it, sign-up, login and mail limits would share one bucket for the whole internet. Any other peer keeps its socket address, whatever header it sends.
- **Public origin of the MCP.** For the same reason the API sees `http://127.0.0.1:8787`, not `https://mcp.renoxium.com`. `CONTROL_MCP_URL=https://mcp.renoxium.com` (in `control.env.example`) gives the platform MCP its OAuth issuer, resource and `Origin` check. Without it, agents get an `http://` issuer and a browser client's `Origin` is refused with 403.
- **Loopback only.** Both control listeners bind `127.0.0.1`. With loopback-only trusted proxies, `control/api` refuses a public `CONTROL_LISTEN_HOST` at start (exit 78, not restarted). The firewall drops 5432, 8787 and 8788 even if a listener is misconfigured.
- **Accepted trade-off (beta).** Tenant code runs on the same machine as Postgres and the platform key. The layers between them are the V8 isolate, seccomp and Landlock (`[sandbox]`, #253), separate users and slices, and tenant `fetch` refusing loopback, private ranges and `fetch_blocked_addresses`. The control plane moves to its own host before the first paying tenant ("Splitting the control plane off" below).

## Files on the host

| Path | Owner, mode | What |
| --- | --- | --- |
| `/opt/renox/src` | root, 0755 | A checkout of this repository at the deployed tag, with `bun install --frozen-lockfile --production` run in it |
| `/opt/renox/bin/{renox-worker,litestream,cloudflared,lego,bun}` | root, 0755 | Each verified by SHA-256 (`bootstrap-node.sh`, `*.lock`) |
| `/opt/renox/bin/{renew-wildcard-cert.sh,backup-control-db.sh}` | root, 0755 | From `ops/scripts/`, installed by `bootstrap-node.sh --single-host` |
| `/etc/renox/worker.toml` | root:renox, 0640 | The worker (`ops/worker.toml.example`) |
| `/etc/renox/control.env` | root, 0600 | Every setting and secret of the control API (`ops/systemd/control.env.example`); systemd reads it as root |
| `/etc/renox/single-host.env` | root, 0644 | Domain and ACME address of the certificate timer (no secret) |
| `/etc/renox/tunnel/config.yml` | root, 0644 | `ops/cloudflared/config.yml.example` with the tunnel id |
| `/etc/renox/tunnel/credentials.json` | root, 0600 | The tunnel's credentials (secret) |
| `/etc/renox/secrets/cloudflare-dns.token` | root, 0600 | Cloudflare API token, DNS edit on `renoxium.app` only (secret) |
| `/etc/renox/secrets/r2-backup.env` | root, 0600 | R2 key pair of the backup bucket (secret) |
| `/etc/renox/backup-age.pub` | root, 0644 | The age **public** key backups are encrypted to; the private key is never on the host |
| `/var/lib/renox-acme` | root, 0700 | lego's ACME account and certificates |
| `/etc/nftables.d/renox-single-host.nft` | root, 0644 | `firewall-single-host.sh`'s rules, included from `/etc/nftables.conf` |

The units that read root-only files (`renox-tunnel`, `renox-cert-renew`, `renox-backup-db`) get a copy through systemd's `LoadCredential=`. The copy is visible only to that unit's process, under `$CREDENTIALS_DIRECTORY`. The service users cannot read the files under `/etc/renox` themselves.

## Cloudflare DNS

Both zones are on Cloudflare DNS. "DNS only" is the grey cloud: Cloudflare answers the name and the client connects straight to the node.

### `renoxium.app` (tenant apps)

| Record | Type | Value | Proxy | Why |
| --- | --- | --- | --- | --- |
| `renoxium.app` | A (and AAAA) | node's public IPv4 (IPv6) | DNS only | The apex: the platform's `security.txt` and the redirect to `renoxium.com`; covered by the wildcard certificate |
| `*.renoxium.app` | A (and AAAA) | node's public IPv4 (IPv6) | DNS only | Every app, `<app>.renoxium.app`. The worker terminates TLS with the wildcard certificate and limits per client address |
| `edge.renoxium.app` | A (and AAAA) | node's public IPv4 (IPv6) | DNS only | The CNAME target of customers' custom domains (`CONTROL_EDGE_HOSTNAME`); custom domains get their certificates by HTTP-01 on port 80 of the node |
| `renoxium.app` | CAA | `0 issue "letsencrypt.org"` and `0 issuewild "letsencrypt.org"` | — | Only Let's Encrypt may issue for the apps' names |
| `_acme-challenge.renoxium.app` | TXT | created and removed by lego | — | DNS-01 for the wildcard (`renew-wildcard-cert.sh`) |
| `_psl.renoxium.app` | TXT | the PSL pull request URL | — | Only when the Public Suffix List entry is submitted (`ops/psl/README.md`) |

`.app` is on the HSTS preload list: browsers use HTTPS only, from the first request. The wildcard certificate must be in place before the first app is shown to anyone.

### `renoxium.com` (the company and the platform's services)

| Record | Type | Value | Proxy | Why |
| --- | --- | --- | --- | --- |
| `renoxium.com` | A (and AAAA) | node's public IPv4 (IPv6) | DNS only | The site (`www/`, a Renox app) attached as a custom domain; certificate by HTTP-01 |
| `www.renoxium.com` | CNAME | `renoxium.com` | DNS only | Same app, second custom domain |
| `dashboard.renoxium.com` | A (and AAAA) | node's public IPv4 (IPv6) | DNS only | The dashboard (`control/dashboard`, a Renox app) attached as a custom domain |
| `api.renoxium.com` | CNAME | `<tunnel id>.cfargotunnel.com` | Proxied | Created by `cloudflared tunnel route dns`; the control API through the tunnel |
| `mcp.renoxium.com` | CNAME | `<tunnel id>.cfargotunnel.com` | Proxied | Same tunnel, the platform MCP (`docs/20-ai-agents-mcp.md`) |
| `renoxium.com` | MX | Zoho's three MX hosts with their priorities | — | Mailboxes `security@`, `abuse@`, `support@` (Zoho); copy the hosts from Zoho's console, which depends on the account's data centre |
| `renoxium.com` | TXT | `v=spf1 include:zoho.com ~all` | — | SPF for mail sent by Zoho. Resend sends from its own subdomain (below), so it is not in the apex SPF |
| `<selector>._domainkey.renoxium.com` | TXT | from Zoho's console | — | Zoho DKIM |
| `send.renoxium.com` | MX and TXT | from Resend's console (its bounce MX and `v=spf1 include:…`) | — | Resend's return path for platform mail (`CONTROL_MAIL_PROVIDER=resend`) |
| `resend._domainkey.renoxium.com` | TXT | from Resend's console | — | Resend DKIM for `no-reply@renoxium.com` |
| `_dmarc.renoxium.com` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@renoxium.com` | — | Start with `p=none`; move to `p=quarantine` once the reports show only Zoho and Resend |

The worker's own addresses go into `fetch_blocked_addresses` (`ops/worker.toml.example`), so tenant code cannot call the node through its public address. The dashboard reaches `api.renoxium.com` through Cloudflare's addresses (ADR D23), like any client.

## Owner accounts and secrets (done once, off the host)

1. **Tunnel.** On the owner's workstation, with `cloudflared` from `ops/cloudflared.lock`:
   ```
   cloudflared tunnel login                     # opens the browser; writes ~/.cloudflared/cert.pem (keep it off the host)
   cloudflared tunnel create renoxium-control   # prints the tunnel id, writes ~/.cloudflared/<id>.json
   cloudflared tunnel route dns renoxium-control api.renoxium.com
   cloudflared tunnel route dns renoxium-control mcp.renoxium.com
   ```
   `<id>.json` is the tunnel's credentials. Copy it to the host as `/etc/renox/tunnel/credentials.json` (`install -m 0600 -o root -g root`) over SSH, never through a chat or a ticket.
2. **DNS-only API token** for the certificate: Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom. Permissions: *Zone → DNS → Edit*. Zone resources: *Include → Specific zone → renoxium.app*. Nothing else. Put it in `/etc/renox/secrets/cloudflare-dns.token` (0600).
3. **R2.** Two buckets in the owner's Cloudflare account: `renoxium-artifacts` (the control API's artifact store) and `renoxium-backups`. On `renoxium-backups`, add a lifecycle rule that deletes objects under `control-db/` after 30 days. Add a bucket lock rule that keeps objects under `control-db/` for 30 days, so the host's key cannot delete a backup early. Then create two R2 API tokens with *Object Read & Write*, each limited to its one bucket. The artifacts pair goes into `control.env` (`CONTROL_S3_*`); the backup pair into `/etc/renox/secrets/r2-backup.env`, in the four-line format of `ops/scripts/backup-control-db.sh`.
4. **Backup key.** On the owner's workstation: `age-keygen -o renoxium-backup.key`. It prints the public key (`age1…`). The private key file goes into the owner's password manager and an offline copy (`ops/security/keys.md`); only the public key goes to the host as `/etc/renox/backup-age.pub`.
5. **Mail (#385).** Every platform email (verification, password reset, new-device and new-token notices, invitations, billing, abuse takedowns, break-glass) goes through Resend:
   - a Resend account; add the domain `renoxium.com` and create the records Resend shows (the `resend._domainkey` DKIM TXT, and the MX and SPF TXT of the `send.` return path; see the DNS table). Wait until Resend marks the domain verified;
   - an API key with *Sending access* limited to `renoxium.com`;
   - in `/etc/renox/control.env`: `CONTROL_MAIL_PROVIDER=resend`, `CONTROL_RESEND_API_KEY=<the key>`, and `CONTROL_MAIL_FROM` (default `Renoxium <no-reply@renoxium.com>`). The API refuses to start with `resend` and no key, or a value that is not a Resend key. Its start-up line names the provider and the sender, never the key.

   A failed delivery is retried, four attempts of at most 5 s each. After the last one the API logs `mail send failed` with the kind and the HTTP status, never the message, and the request that sent the mail still succeeds. Zoho keeps the mailboxes or aliases `security@`, `abuse@`, `support@renoxium.com`; Resend only sends.

## Install, in order

All commands as root on the host unless the step says otherwise.

1. **Base.** Ubuntu 24.04 with current updates. sshd with key authentication only (port 22, or another port: the firewall step takes it). Then: `apt-get install -y postgresql nftables age curl openssl git`.
2. **Firewall.** `ops/scripts/firewall-single-host.sh --dry-run` shows the rules, then run it without `--dry-run`. When sshd runs on another port, pass it: `--ssh-port 49222` (both runs). It refuses to change anything unless sshd listens on that port (Ubuntu 24.04 starts it through `ssh.socket`, which counts) and the SSH session you run it from arrived on it; only that one port is opened for SSH. Keep a second SSH session open while you run it the first time.
3. **Source and Bun.** Check out the deployed tag into `/opt/renox/src`. Install Bun 1.4.4 (the version CI uses): download `bun-linux-x64.zip` and `SHASUMS256.txt` from the `bun-v1.4.4` release and compare with `sha256sum`. Then `install -m 0755 bun /opt/renox/bin/bun`, and run `/opt/renox/bin/bun install --frozen-lockfile --production` in `/opt/renox/src`.
4. **Postgres.** The distribution's Postgres listens on `localhost` only (check `listen_addresses` in `/etc/postgresql/16/main/postgresql.conf`). Create the role and the database:
   ```
   sudo -u postgres psql -c "create role renox_control login password '<openssl rand -hex 24>'"
   sudo -u postgres createdb -O renox_control renox
   ```
   The password goes into `CONTROL_DATABASE_URL` in `control.env`. `pg_hba.conf` keeps the distribution's `scram-sha-256` for `127.0.0.1/32`. The backup timer connects as `postgres` over the local socket (peer authentication).
5. **Node bootstrap.**
   ```
   ops/scripts/bootstrap-node.sh --single-host --no-enable --worker-version <version> \
     --node-id node-small --control-url http://127.0.0.1:8788 \
     --blocked-addresses <public IPv4>,<public IPv6>,127.0.0.1 \
     --node-token-file /root/node.token.placeholder
   ```
   This installs the worker, Litestream, cloudflared and lego (each SHA-256 verified), the units and timers, the `renox-control` user, and the templates `/etc/renox/control.env`, `single-host.env` and `tunnel/config.yml`. It enables nothing yet. Every template is written once; a second run leaves your edits alone.
6. **Control plane.** Fill in `/etc/renox/control.env`: every `@…@` value, the mail keys, and the artifacts bucket. Then:
   ```
   systemctl enable --now renox-control.service
   curl -fsS http://127.0.0.1:8787/v1/healthz && curl -fsS http://127.0.0.1:8788/v1/healthz
   ss -tlnp | grep -E ':878[78]'          # both on 127.0.0.1 only
   ```
   Issue the node's token with the operator token (`POST /v1/admin/nodes` on `127.0.0.1:8787`, body `{"node_id": "node-small"}`), and write the `token` of the answer to `/etc/renox/node.token` (root:renox, 0640).
7. **Tunnel.** Put the tunnel id into `/etc/renox/tunnel/config.yml`, the credentials file in place (step 1 of the owner list), then `systemctl enable --now renox-tunnel.service`. From outside: `curl -fsS https://api.renoxium.com/v1/healthz`.
8. **Wildcard certificate.** Set `RENOX_APP_DOMAIN` and `RENOX_ACME_EMAIL` in `/etc/renox/single-host.env`. Try the setup against Let's Encrypt's staging directory first; it installs nothing and reloads nothing:
   ```
   /opt/renox/bin/renew-wildcard-cert.sh --staging --domain renoxium.app --email ops@renoxium.com \
     --token-file /etc/renox/secrets/cloudflare-dns.token --lego-path /var/lib/renox-acme-staging \
     --cert-dir /tmp/staging-certs --reload-cmd true
   ```
   Then the real one: `systemctl start renox-cert-renew.service`, and `systemctl enable --now renox-cert-renew.timer`. The files land in `/var/lib/renox/data/_certs/_wildcard.renoxium.app/` and `…/renoxium.app/`.
9. **Worker.** `systemctl enable --now renox-node.target`. Check `curl -fsS http://127.0.0.1:9090/healthz` (the `health_listen`), and that the control API knows the node (`GET /v1/ops/nodes/node-small` with an operator token holding `ops:read`).
10. **The platform's own apps.** Sign up the platform's tenant (`control/dashboard/README.md`, "Deploy as the first internal tenant"), deploy `control/dashboard` and `www/`, then attach the custom domains: `POST /v1/apps/<app>/domains` with `dashboard.renoxium.com` for the dashboard, and `renoxium.com` and `www.renoxium.com` for the site. The worker gets their certificates by HTTP-01 on port 80. Check `https://dashboard.renoxium.com/` and `https://renoxium.com/`.
11. **Backups.** `/etc/renox/backup-age.pub` and `/etc/renox/secrets/r2-backup.env` in place, then `systemctl start renox-backup-db.service` once. Check its journal line (`backup-control-db: renox -> renoxium-backups/control-db/…`), then `systemctl enable --now renox-backup-db.timer`. Run the restore drill below once.

### Health checks after every change

| Check | Expect |
| --- | --- |
| `systemctl is-active renox-worker renox-control renox-tunnel` | `active` three times |
| `systemctl list-timers 'renox-*'` | both timers with a next run |
| `nft list table inet renox_single_host` | the input chain with `tcp dport 22 accept` and `tcp dport { 80, 443 } accept` |
| From another machine: `nc -z <node> 5432`, `8787`, `8788` | all refused or timed out |
| `curl -fsS https://api.renoxium.com/v1/healthz` | 200 through the tunnel |
| `curl -sI https://<app>.renoxium.app/` | the wildcard certificate (`openssl s_client -servername <app>.renoxium.app -connect <node>:443`) |
| `journalctl -u renox-cert-renew -n 5` | `installed a new certificate` or `unchanged`, never an error |
| `journalctl -u renox-backup-db -n 5` | last night's object key and size |

## Backups

| What | Where | How often | Keeps |
| --- | --- | --- | --- |
| Control database | `renoxium-backups/control-db/<yyyy>/<mm>/control-db-<stamp>.dump.age` | nightly, `renox-backup-db.timer` | 30 days (lifecycle rule and bucket lock) |
| Tenant files | **not yet on R2**, see below | — | — |
| Artifacts | `renoxium-artifacts`; artifacts are content-addressed and re-uploadable by `renox deploy` | on deploy | while referenced |

`backup-control-db.sh` runs `pg_dump --format=custom`, pipes the dump into `age` to the public key, and uploads it with an S3 PUT that curl signs (SigV4, region `auto`). It then reads the object's size back. The R2 secret reaches curl on its standard input. A failing `pg_dump` fails the run and uploads nothing.

**Tenant files to R2: blocked.** The worker refuses an `s3` replica in controlled mode unless its region is in `allowed_regions` (by default the UAE, `me-central-1`) and it names `sse_kms_key_id`. R2 has region `auto` and no KMS (`crates/renox-cell/src/config.rs`, #120). Pointing Litestream at R2 therefore needs a change in `renox-cell`, plus an owner decision on keeping tenant data outside the UAE. #366 records it as a follow-up. Until then a tenant file lives only on the node's disk, so one disk failure loses tenant data. Do not take tenants that need durable data before it is resolved.

### Restore drill

Run it on a scratch host or container, never on the production host. Recorded run: 2026-11-02, in this session's dev container, Postgres 16.10, a control database migrated to all 26 migrations plus 2,000 tenants. The backup took 0.36 s (132,773 bytes encrypted); download, decryption and `pg_restore` took 1.7 s. The restored database had the same 2,000 tenants and 26 migrations. The object came from a stand-in S3 server, not R2 (no R2 account in the session).

```
# Control database: newest object, decrypted with the private key (on the owner's workstation), restored.
curl --aws-sigv4 "aws:amz:auto:s3" --config <(printf 'user = "%s:%s"\n' "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY") \
  -o latest.dump.age "https://<account id>.r2.cloudflarestorage.com/renoxium-backups/control-db/<yyyy>/<mm>/<object>"
age --decrypt --identity renoxium-backup.key latest.dump.age > latest.dump
createdb renox_restore
pg_restore --dbname renox_restore --no-owner --exit-on-error latest.dump
psql -d renox_restore -Atc "select count(*) from tenants; select count(*) from schema_migrations"
```

Tenant file (once Litestream replicates off the box; today the drill uses a `file` replica). Recorded run on 2026-11-02 with the pinned Litestream 0.3.13 in a container: a WAL-mode file with 5,000 rows plus 1,000 written while replicating was deleted, then restored in 0.04 s with 6,000 rows and `pragma quick_check` = `ok`.

```
litestream restore -config <run_dir>/litestream/<database>.yml -o /tmp/app.db.restored /var/lib/renox/data/<tenant>/app.db
sqlite3 /tmp/app.db.restored 'pragma quick_check'
```

In production the worker does this itself before it opens a missing or corrupt file (`crates/renox-cell/README.md`, "Replication").

## Splitting the control plane off (before the first paying tenant)

The single host puts tenant code next to Postgres and the master key. Move the control plane to its own host before the first paying tenant, or earlier if the worker needs the whole machine (CPU or memory alerts in `ops/observability/`).

1. Set up the new host with steps 1 to 4 and 6 above (no worker). Its node listener binds a private address the worker can reach (`CONTROL_NODE_LISTEN_HOST=<private address>`), firewalled to the worker's address only.
2. Restore the newest control-database backup there, stop `renox-control` on the old host, take a last backup, restore it, and start `renox-control` on the new host.
3. **The tunnel moves with it.** Copy `/etc/renox/tunnel/` to the new host and start `renox-tunnel` there. `api` and `mcp.renoxium.com` keep their CNAME to the same tunnel id. Nothing changes for clients, the CLI or the dashboard.
4. On the worker: `[control] url = "https://<private address>:8788"` (TLS between hosts), `fetch_blocked_addresses` gains the new private address, and the old `127.0.0.1` entry can stay. Restart the worker.
5. On the old host: `systemctl disable --now renox-control renox-tunnel renox-backup-db.timer`. Remove `/etc/renox/control.env`, `/etc/renox/tunnel/credentials.json` and the backup secrets, and drop the database.

## Where this stopped (owner steps)

The session that wrote this page (#366) had no Cloudflare, R2, Resend or Zoho account and no access to the production host. It tested every script in containers (`ops/README.md`, "Single host"), and stopped at:

- creating the tunnel, its credentials and the DNS routes (owner list, step 1);
- the DNS-only API token and the first real certificate (owner list, step 2; install, step 8);
- the R2 buckets, lifecycle and lock rules, keys, and a backup to real R2 (owner list, step 3);
- the backup key pair (owner list, step 4);
- Resend and Zoho, their DNS records, and the Resend key in `control.env` (owner list, step 5; the mailer itself is tested against a fake Resend, `control/api/tests/mailer.test.ts`);
- install steps 1 to 11 on `node-small` itself;
- Litestream replication of tenant files to R2 ("Backups" above).
