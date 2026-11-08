# Single host: Renoxium on one machine behind Cloudflare, tunnel-only

The first production of Renoxium (#366) runs on one machine (`node-small`: 4 vCPU, 8 GB, Ubuntu 24.04, KVM VPS). Since ADR D25 (#421) it is **tunnel-only**: every public name reaches it through a Cloudflare Tunnel, and nothing listens on a public port but SSH.

- the **worker** serves tenant apps on `<app>.renoxium.app` and every custom domain (Cloudflare for SaaS custom hostnames, the platform's own `renoxium.com`, `www.renoxium.com` and `dashboard.renoxium.com` included), as plain HTTP/1.1 on a unix socket that only `cloudflared` reaches;
- the **control plane** (`control/api` on Bun, Postgres from the distribution) answers `api.renoxium.com` and `mcp.renoxium.com` through the same tunnel;
- **Cloudflare** terminates TLS (edge certificates, Cloudflare for SaaS for custom domains), serves IPv6, absorbs DDoS, and keeps warm connections to the host through the tunnel;
- backups and tenant-file replicas go to **Cloudflare R2**.

This page takes an empty host to live ("Install, in order"), and an existing host from the old DNS-only layout to this one ("Cut-over of an existing host"). Every secret it names lives in a root-only file on the host or with the owner, never in this repository, an issue, a PR or a log line.

## What runs where

```
 visitors ──► Cloudflare edge (TLS, HTTP/2, DDoS, certificates)
                 *.renoxium.app, renoxium.app        api.renoxium.com, mcp.renoxium.com
                 custom hostnames (Cloudflare for SaaS, fallback origin renoxium.app)    
                         │ the tunnel: outbound from the host, no inbound port
                         ▼
 ┌──────────────────────────── node-small ─────────────────────────────────────┐
 │ nftables: inbound SSH only (22 or --ssh-port); 80 and 443 closed            │
 │                                                                             │
 │ renox-tunnel (cloudflared, user renox-tunnel, group renox-edge)             │
 │   │ apps, custom hostnames            │ api, mcp                            │
 │   ▼ unix:/run/renox-edge/worker.sock  ▼ http://127.0.0.1:8787               │
 │ renox-worker (user renox)           renox-control (Bun)                     │
 │   plain HTTP/1.1, no TLS,             public  127.0.0.1:8787                │
 │   trusts CF-Connecting-IP from        node    127.0.0.1:8788 ◄── worker only│
 │   the renox-tunnel uid only                    │                            │
 │        └── [control] url ─────────────────────┘                            │
 │                                       Postgres 127.0.0.1:5432               │
 │ timers: renox-backup-db (pg_dump → R2), renox-billing (hourly rollup);      │
 │ renox-litestream@ (tenant files → R2); renox-alert@ on a failed unit        │
 └─────────────────────────────────────────────────────────────────────────────┘
```

- **Tunnel-only (ADR D25).** `cloudflared` is the host's only way in. The worker has no TLS, no certificate, no port 80 and no HTTP/2: Cloudflare does all of it. The host's address is never published in DNS.
- **Client addresses.** Behind the tunnel every request comes from `cloudflared`. The worker listens on `unix:/run/renox-edge/worker.sock` (mode 0660, group `renox-edge`) and believes `CF-Connecting-IP` only from a peer whose uid, read from the socket by the kernel (`SO_PEERCRED`), is `renox-tunnel` (`[gateway] trusted_socket_users`, #414). Any other local process that reaches the socket (a tenant child process runs as `renox` too) counts as `127.0.0.1`, and the forwarding headers never reach tenant code. Per-IP rate limits, client events and logs key on the visitor's address. On the API, `CONTROL_TRUSTED_PROXIES=127.0.0.1,::1` does the same for the loopback listener (`control/api/src/auth/ip.ts`).
- **HTTPS as the visitor saw it.** `cloudflared` sends `X-Forwarded-Proto: https`; from the trusted peer the worker adds HSTS and CSP `upgrade-insecure-requests` and expects `https://` origins on client events (#418).
- **Cloudflare's limits.** A response with no byte for about 100 s is cut (524): the platform's streams send a keep-alive every 15 s. A request body above 100 MB is refused at the edge. `text/event-stream` and chunked responses are not buffered, because the ingress never sets `disableChunkedEncoding`. `cloudflared` keeps `Host` (no `httpHostHeader`): routing and the realtime `Origin` check depend on it.
- **Public origin of the MCP.** The API sees `http://127.0.0.1:8787`, not `https://mcp.renoxium.com`. `CONTROL_MCP_URL=https://mcp.renoxium.com` (in `control.env.example`) gives the platform MCP its OAuth issuer, resource and `Origin` check.
- **Custom domains.** Cloudflare for SaaS on the `renoxium.app` zone: the control API creates a custom hostname per domain (`CONTROL_CF_*`), Cloudflare validates ownership with its TXT record and issues the certificate, and the traffic reaches the worker through the fallback origin, the zone apex `renoxium.app` (ADR D26: there is no separate `edge` name), and the tunnel's catch-all rule (`control/api/src/domains/README.md`). Customers point their hostname at `renoxium.app` with a CNAME. Customers' apexes: "use `www`, redirect the apex".
- **No privileged port.** The worker holds no capability (`renox-worker.service`); `renox-child@` units neither.
- **Loopback only.** Both control listeners bind `127.0.0.1`. With loopback-only trusted proxies, `control/api` refuses a public `CONTROL_LISTEN_HOST` at start (exit 78, not restarted). The firewall drops every inbound port but SSH even if a listener is misconfigured.
- **One process for every tenant (#403).** The single host keeps `[process]` off: no supervisor, no `renox-child@` units, and every tenant, a `paid` one included, runs in the worker's shared process. The control plane still writes `process = "own"` into a paid tenant's route entry and `getOpsTenant` shows `process: own`; the worker logs one warning per such tenant (`route entry asks for process = "own" but [process] is off on this worker; the tenant runs in the shared process`), so `journalctl -u renox-worker | grep 'process = \"own\"'` lists the isolation the console promises and the host does not give. The heartbeat cannot report it yet (#403). Turning it on, with `[process] enabled = true` and `launcher = "systemd"` (`crates/renox-cell/README.md`, "Process tiers"), belongs with the first paying tenant, like the control plane's own host below.
- **Accepted trade-off (beta).** Tenant code runs on the same machine as Postgres and the platform key. The layers between them are the V8 isolate, seccomp and Landlock (`[sandbox]`, #253), separate users and slices, and tenant `fetch` refusing loopback, private ranges and `fetch_blocked_addresses`. The control plane moves to its own host before the first paying tenant ("Splitting the control plane off" below).

## Files on the host

| Path | Owner, mode | What |
| --- | --- | --- |
| `/opt/renox/src` | root, 0755 | A checkout of this repository at the deployed commit, with `bun install --frozen-lockfile` run in it (step 3); runs the control API |
| `~<operator>/renox-deploy` | the operator, 0755 | A second checkout of the same commit, owned by the operator's own user, for `renox deploy` of the platform's apps (step 9); never `/opt/renox/src` |
| `/opt/renox/bin/{renox-worker,litestream,cloudflared,bun}` | root, 0755 | Each verified by SHA-256 (`bootstrap-node.sh`, `*.lock`) |
| `/opt/renox/bin/backup-control-db.sh`, `/opt/renox/bin/renox-alert.sh` | root, 0755 | From `ops/scripts/`, installed by `bootstrap-node.sh --single-host` |
| `/etc/renox/secrets/alert.env` | root, 0600 | `ALERT_WEBHOOK_URL=https://…`: where `renox-alert@.service` posts a failed unit (secret, step 11) |
| `/etc/renox/worker.toml` | root:renox, 0640 | The worker (`ops/worker.toml.example`): `listen = "unix:/run/renox-edge/worker.sock"`, `[gateway] trusted_socket_users = ["renox-tunnel"]`, `socket_group = "renox-edge"` |
| `/etc/renox/node.token`, `/etc/renox/platform.key` | renox:renox, 0400 | The node token (`renox_node_…`, step 6) and the page session key (32 random bytes, written once by `bootstrap-node.sh`). The worker refuses either file with any group or other bit |
| `/etc/tmpfiles.d/renox-edge.conf` | root, 0644 | `d /run/renox-edge 0750 renox renox-edge -`: the socket's directory, made at every boot |
| `/run/renox-edge/worker.sock` | renox:renox-edge, 0660 | The worker's socket; `cloudflared` (user `renox-tunnel`, group `renox-edge`) connects to it |
| `/etc/renox/control.env` | root, 0600 | Every setting and secret of the control API (`ops/systemd/control.env.example`), `CONTROL_CF_*` included; systemd reads it as root |
| `/etc/renox/tunnel/config.yml` | root, 0644 | `ops/cloudflared/config.yml.example` with the tunnel id |
| `/etc/renox/tunnel/credentials.json` | root, 0600 | The tunnel's credentials (secret) |
| `/etc/renox/secrets/r2-backup.env` | root, 0600 | R2 key pair of the backup bucket (secret) |
| `/etc/renox/secrets/r2-replica.env` | root, 0600 | R2 key pair of the `renoxium-replicas` bucket, for Litestream and the worker (secret, #417) |
| `/etc/renox/backup-age.pub` | root, 0644 | The age **public** key backups are encrypted to; the private key is never on the host |
| `/etc/nftables.d/renox-single-host.nft` | root, 0644 | `firewall-single-host.sh`'s rules, included from `/etc/nftables.conf` |

`renox-backup-db` and `renox-backup-tenants` run as root (#517) and read the backup files directly; `renox-tunnel` gets a copy through systemd's `LoadCredential=`; `renox-worker` and `renox-litestream@` get the R2 replica pair through `EnvironmentFile=`, which systemd reads as root. The service users cannot read the files under `/etc/renox` themselves. systemd 255 makes a credential copy root-owned 0440, readable by the unit's user through an ACL, when the unit has a `User=`; `backup-control-db.sh` accepts group read only for a file in its own `$CREDENTIALS_DIRECTORY`.

## Cloudflare

Both zones are on Cloudflare DNS. "Proxied" is the orange cloud (through Cloudflare's edge), "DNS only" the grey one.

### `renoxium.app` (tenant apps; the Cloudflare for SaaS zone)

| Record | Type | Value | Proxy | Why |
| --- | --- | --- | --- | --- |
| `renoxium.app` | CNAME (flattened at the apex) | `<tunnel id>.cfargotunnel.com` | Proxied | The apex: the platform's `security.txt` and the redirect to `renoxium.com`, **and** the Cloudflare for SaaS fallback origin and CNAME target of every custom domain (`CONTROL_CF_FALLBACK_ORIGIN`, ADR D26). Created by `cloudflared tunnel route dns` |
| `*.renoxium.app` | CNAME | `<tunnel id>.cfargotunnel.com` | Proxied | Every app, `<app>.renoxium.app`, through the tunnel to the worker |
| `_psl.renoxium.app` | TXT | the PSL pull request URL | — | Only when the Public Suffix List entry is submitted (`ops/psl/README.md`) |

No A or AAAA record names the host, and there are no CAA or `_acme-challenge` records: Cloudflare issues every certificate. `.app` is on the HSTS preload list; Cloudflare's edge certificate covers `renoxium.app` and `*.renoxium.app` (Universal SSL).

**Cloudflare for SaaS** (SSL/TLS → Custom Hostnames on the `renoxium.app` zone): enabled, fallback origin `renoxium.app` (Active). There is no `edge.renoxium.app` record (ADR D26). Custom hostnames are created by the control API only; do not add them by hand.

### `renoxium.com` (the company and the platform's services)

| Record | Type | Value | Proxy | Why |
| --- | --- | --- | --- | --- |
| `renoxium.com` | CNAME (flattened at the apex) | `renoxium.app` | DNS only | The site (`www/`), a custom hostname of the platform tenant (ADR D25: the platform dogfoods the customer path) |
| `www.renoxium.com` | CNAME | `renoxium.app` | DNS only | Same app, second custom hostname |
| `dashboard.renoxium.com` | CNAME | `renoxium.app` | DNS only | The dashboard (`control/dashboard`), a custom hostname of the platform tenant |
| `_cf-custom-hostname.<name>` and `_acme-challenge.<name>` for the three names above | TXT | from each `addDomain` answer (`verification`) | — | Cloudflare's ownership and certificate validation records; keep them |
| `api.renoxium.com` | CNAME | `<tunnel id>.cfargotunnel.com` | Proxied | Created by `cloudflared tunnel route dns`; the control API through the tunnel |
| `mcp.renoxium.com` | CNAME | `<tunnel id>.cfargotunnel.com` | Proxied | Same tunnel, the platform MCP (`docs/20-ai-agents-mcp.md`) |
| `renoxium.com` | MX | Zoho's three MX hosts with their priorities | — | Mailboxes `security@`, `abuse@`, `support@` (Zoho); copy the hosts from Zoho's console |
| `renoxium.com` | TXT | `v=spf1 include:zoho.com ~all` | — | SPF for mail sent by Zoho. Resend sends from its own subdomain (below) |
| `<selector>._domainkey.renoxium.com` | TXT | from Zoho's console | — | Zoho DKIM |
| `send.renoxium.com` | MX and TXT | from Resend's console (its bounce MX and `v=spf1 include:…`) | — | Resend's return path for platform mail (`CONTROL_MAIL_PROVIDER=resend`) |
| `resend._domainkey.renoxium.com` | TXT | from Resend's console | — | Resend DKIM for `no-reply@renoxium.com` |
| `_dmarc.renoxium.com` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@renoxium.com` | — | Start with `p=none`; move to `p=quarantine` once the reports show only Zoho and Resend |

The three platform names stay **DNS only**: a grey CNAME to `renoxium.app` keeps them on the plain Cloudflare for SaaS path, so the Orange-to-Orange rules of a proxied customer zone do not apply (to verify at the cut-over and record in ADR D25).

The worker's own public addresses still go into `fetch_blocked_addresses` (`ops/worker.toml.example`), so tenant code cannot call the node through its public address. The dashboard reaches `api.renoxium.com` through Cloudflare's addresses (ADR D23), like any client.

## Owner accounts and secrets (done once, off the host)

1. **Tunnel.** On the owner's workstation, with `cloudflared` from `ops/cloudflared.lock`:
   ```
   cloudflared tunnel login                     # opens the browser; writes ~/.cloudflared/cert.pem (keep it off the host)
   cloudflared tunnel create renoxium           # prints the tunnel id, writes ~/.cloudflared/<id>.json
   for name in api.renoxium.com mcp.renoxium.com renoxium.app '*.renoxium.app'; do
     cloudflared tunnel route dns renoxium "$name"
   done
   ```
   `<id>.json` is the tunnel's credentials. Copy it to the host as `/etc/renox/tunnel/credentials.json` (`install -m 0600 -o root -g root`) over SSH, never through a chat or a ticket. (An existing host keeps its tunnel, `renoxium-control`: "Cut-over of an existing host".)
2. **Cloudflare for SaaS.** On the `renoxium.app` zone: SSL/TLS → Custom Hostnames → enable, fallback origin `renoxium.app` (the apex record of step 1; ADR D26). If Cloudflare refuses the apex as fallback origin, route one other name of the zone through the tunnel, use it here and in `CONTROL_CF_FALLBACK_ORIGIN`, and record it in ADR D26. Check the plan's included custom hostnames and the price per hostname above it (understood: 100 included, then about $0.10 per hostname per month) and record the numbers in ADR D25. Then an API token: My Profile → API Tokens → Create Token → Custom. Permissions: *Zone → SSL and Certificates → Edit*. Zone resources: *Include → Specific zone → renoxium.app*. Nothing else. It goes into `control.env` as `CONTROL_CF_API_TOKEN`, with `CONTROL_CF_ZONE_ID` (the zone's overview page) and `CONTROL_CF_FALLBACK_ORIGIN=renoxium.app`. The DNS-edit token of the old layout is no longer needed: revoke it.
3. **R2.** Three buckets in the owner's Cloudflare account: `renoxium-artifacts` (the control API's artifact store), `renoxium-backups` and `renoxium-replicas` (tenant files, #417). On `renoxium-backups`, add a lifecycle rule that deletes objects under `control-db/` after 30 days, and a bucket lock rule that keeps them for 30 days, so the host's key cannot delete a backup early. Then three R2 API tokens with *Object Read & Write*, each limited to its one bucket. The artifacts pair goes into `control.env` (`CONTROL_S3_*`); the backup pair into `/etc/renox/secrets/r2-backup.env`, in the four-line format of `ops/scripts/backup-control-db.sh`; the replicas pair into `/etc/renox/secrets/r2-replica.env` ("Backups", "Tenant files to R2").
4. **Backup key.** On the owner's workstation: `age-keygen -o renoxium-backup.key`. It prints the public key (`age1…`). The private key file goes into the owner's password manager and an offline copy (`ops/security/keys.md`); only the public key goes to the host as `/etc/renox/backup-age.pub`.
5. **Mail (#385).** Every platform email (verification, password reset, new-device and new-token notices, invitations, billing, abuse takedowns, break-glass) goes through Resend:
   - a Resend account; add the domain `renoxium.com` and create the records Resend shows (the `resend._domainkey` DKIM TXT, and the MX and SPF TXT of the `send.` return path; see the DNS table). Wait until Resend marks the domain verified;
   - an API key with *Sending access* limited to `renoxium.com`;
   - in `/etc/renox/control.env`: `CONTROL_MAIL_PROVIDER=resend`, `CONTROL_RESEND_API_KEY=<the key>`, and `CONTROL_MAIL_FROM` (default `Renoxium <no-reply@renoxium.com>`). The API refuses to start with `resend` and no key, or a value that is not a Resend key. Its start-up line names the provider and the sender, never the key.

   A failed delivery is retried, four attempts of at most 5 s each. After the last one the API logs `mail send failed` with the kind and the HTTP status, never the message, and the request that sent the mail still succeeds. Zoho keeps the mailboxes or aliases `security@`, `abuse@`, `support@renoxium.com`; Resend only sends.

## Install, in order

All commands as root on the host unless the step says otherwise.

1. **Base.** Ubuntu 24.04 with current updates. sshd with key authentication only (port 22, or another port: the firewall step takes it). A host that already runs something (a web server, ufw, Docker) is cleared first: "A host that is not empty" below. Then: `NEEDRESTART_MODE=l apt-get install -y postgresql nftables age curl openssl git jq sqlite3` (`sqlite3` for the tenant snapshot and the restore drill; `age` and `pg_dump` for the control-database backup; `bootstrap-node.sh --single-host` warns when one is missing). If the provider's IPv6 egress is unreliable, apply "Host networking" below now.
2. **Firewall.** `ops/scripts/firewall-single-host.sh --dry-run` shows the rules, then run it without `--dry-run`. Only the SSH port is opened; 80 and 443 stay closed. When sshd runs on another port, pass it: `--ssh-port 49222` (both runs). It refuses to change anything unless sshd listens on that port (Ubuntu 24.04 starts it through `ssh.socket`, which counts) and the SSH session you run it from arrived on it. Keep a second SSH session open while you run it the first time.
3. **Source and Bun.** There is no application release tag: the only tags are the worker's (`worker-v*`, used in step 5). Deploy a reviewed commit of `main`, the one whose CI is green, and write its SHA down in the change log (`git -C /opt/renox/src rev-parse HEAD`); an upgrade is a checkout of a newer reviewed commit. Check it out into `/opt/renox/src` (root-owned). Install Bun 1.4.4 (the version CI uses): download `bun-linux-x64.zip` and `SHASUMS256.txt` from the `bun-v1.4.4` release and compare with `sha256sum`. Then `install -m 0755 bun /opt/renox/bin/bun`, and run `/opt/renox/bin/bun install --frozen-lockfile --production` in `/opt/renox/src`.

   `--production` leaves out the dev toolchain and the development database (#400): the SDK's `prepare` skips its build (the host runs only `control/api`, which does not import the SDK), and the control API loads PGlite only for a `pglite:` URL, so on Postgres it starts without it. `ops/scripts/production-install.test.sh` checks both: it installs the tracked files with `--production` and starts the API from that tree.

   **Deploy checkout.** `renox deploy` of the platform's own apps (step 9) does not run from `/opt/renox/src`: that tree is root's, and the CLI writes `.renox/` next to `renox.toml`. As the operator's own user, clone the same commit into a directory of your own (`~/renox-deploy`), run `/opt/renox/bin/bun install --frozen-lockfile` there (it builds `sdk/dist`, which `control/dashboard` and `www` import), and point the CLI at the installed worker, which it runs for `renox-worker check-policies` before every deploy:
   ```
   export RENOX_WORKER_PATH=/opt/renox/bin/renox-worker
   ```
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
   Add `--worker-variant pdf` when the node runs apps that call `ctx.pdf` (the `tax_gcc` invoices, `reports`): the default release build answers `pdf_unavailable`. The script downloads `renox-worker-<version>-<target>-pdf.gz`, checks it against its `.sha256`, unpacks it and records the variant in `/opt/renox/worker-variant`. Changing the variant of an installed version needs no `--upgrade`; the worker restarts.
   This installs the worker, Litestream and cloudflared (each SHA-256 verified), the units and timers, the `renox-control` user, the group `renox-edge` and the user `renox-tunnel`, `/etc/tmpfiles.d/renox-edge.conf` (and `/run/renox-edge`), `/etc/renox/platform.key` (renox:renox 0400), and the templates `/etc/renox/worker.toml`, `control.env` and `tunnel/config.yml`. It enables nothing yet. Every template is written once; a second run leaves your edits alone, and sets `node.token` and `platform.key` back to renox:renox 0400 if an older bootstrap left them root:renox 0640 (the worker refuses those).
6. **Control plane.** Fill in `/etc/renox/control.env`: every `@…@` value, the mail keys, the artifacts bucket, and `CONTROL_CF_*` (owner list, step 2; without them `addDomain` answers 503). Then:
   ```
   systemctl enable --now renox-control.service
   curl -fsS http://127.0.0.1:8787/v1/healthz && curl -fsS http://127.0.0.1:8788/v1/healthz
   ss -tlnp | grep -E ':878[78]'          # both on 127.0.0.1 only
   ```
   Issue the node's token with the operator token (`POST /v1/admin/nodes` on `127.0.0.1:8787`, body `{"node_id": "node-small"}`), and write the `token` of the answer to `/etc/renox/node.token`: `install -m 0400 -o renox -g renox <file> /etc/renox/node.token`, then remove the file you wrote it to. The worker refuses a token or platform key file with any group or other bit.
7. **Worker.** `systemctl enable --now renox-node.target`. Check `curl -fsS http://127.0.0.1:9090/healthz` (the `health_listen`), `stat -c '%F %U:%G %a' /run/renox-edge/worker.sock` (`socket renox:renox-edge 660`), and that the control API knows the node (`GET /v1/ops/nodes/node-small` with an operator token holding `ops:read`).
8. **Tunnel.** Put the tunnel id into `/etc/renox/tunnel/config.yml`, the credentials file in place (owner list, step 1), then `systemctl enable --now renox-tunnel.service`. From outside: `curl -fsS https://api.renoxium.com/v1/healthz`, and `curl -sI https://renoxium.app/.well-known/security.txt` (200, served by the worker through the tunnel).
9. **The platform's own apps.** They run as `dashboard` and `www`, apps of one ordinary tenant that an operator marks as the platform tenant. Only that tenant may use reserved app names, or attach custom domains in its first 7 days (`control/api/README.md`, "Platform tenant", #396). The commands are in `control/dashboard/README.md`, "Deploy as the platform tenant". In order:
    1. Sign up the tenant (`renoxium`) and its owner with `POST /v1/account/signup`.
    2. Verify the address with `POST /v1/account/verify {"token": …}`. The token is the part after `#token=` in the mail's link; the dashboard that would read it is not deployed yet.
    3. Log in (`POST /v1/account/login`) for a session and its CSRF value.
    4. Run `renox login --api https://api.renoxium.com` and, while it polls, approve its code with `POST /v1/account/device/approve` and that session.
    5. On the host, with the operator token, mark the tenant: `POST http://127.0.0.1:8787/v1/ops/tenants/renoxium/platform {"platform": true, "reason": …}`.
    6. Create the app `dashboard`, set its `DASHBOARD_KEY`, then `renox deploy` in `control/dashboard` and in `www/` (no renamed apps, no edited `renox.toml`). Both answer at once on `https://dashboard.renoxium.app/` and `https://www.renoxium.app/`.
    7. Attach each hostname with `POST /v1/apps/<app>/domains`: `dashboard.renoxium.com` to `dashboard`, `renoxium.com` and `www.renoxium.com` to `www`. Each answer names the records to create (`verification`) and the CNAME target (`renoxium.app`).
    8. In the `renoxium.com` zone create the three DNS-only CNAMEs to `renoxium.app` (the apex flattened) and every TXT record of the answers, and keep them.

    The job reads each custom hostname every minute. `GET /v1/apps/<app>/domains/<hostname>` moves to `state: verified`, `status: active`, `ssl_status: active`. Check `https://dashboard.renoxium.com/` and `https://renoxium.com/`. A domain detached by the status poll (three negative answers over at least 30 minutes; an API error never counts) comes back when you repeat its `POST …/domains`: it answers 201 with the same custom hostname and is read at the next tick.

    **CAPTCHA on sign-up (#540), in this order.** First the Turnstile site key on the dashboard (`renox secrets set RENOX_CAPTCHA_SITE_KEY --app dashboard`) and a deploy of the dashboard, so `/signup` shows the widget and sends `captcha_token`. Then `RENOX_CAPTCHA_SECRET=<secret key>` in `control.env`, then `systemctl restart renox-control`. The other way round, sign-up answers 400 `captcha_token: required` to every visitor.
10. **Backups.** Without `R2_ENDPOINT` in `/etc/renox/secrets/r2-backup.env`, "Local backups (no R2)" under "Backups": enable both timers and run `restore-check.sh` once. On a host whose control dumps go to R2 (`node-small`), "Which check covers which backup" below. With R2: `/etc/renox/backup-age.pub` and `/etc/renox/secrets/r2-backup.env` in place, then `systemctl start renox-backup-db.service` once. Check its journal line (`backup-control-db: renox -> renoxium-backups/control-db/…`), then `systemctl enable --now renox-backup-db.timer`. Then "Tenant files to R2" (steps 1 to 4 under "Backups"), and run both restore drills once.
11. **Alerts for failed units (#450).** `renox-backup-db.service` and `renox-billing.service` start `renox-alert@<unit>.service` when they fail (`OnFailure=`). It posts to the webhook in `/etc/renox/secrets/alert.env`, the same receiver as Alertmanager (`ops/observability/README.md`, "Alertmanager on the single host"):
    ```
    printf 'ALERT_WEBHOOK_URL=%s\n' '<https webhook url>' | install -m 0600 -o root -g root /dev/stdin /etc/renox/secrets/alert.env
    systemctl start renox-alert@test.service     # a test alert: "test failed on node-small" arrives
    ```
    Without the file a failure is only in the journal: `renox-alert@<unit>.service` still runs and succeeds (#545; the unit's `SetCredential=` fallback stands in for the missing file), and `journalctl -u 'renox-alert@*'` shows `renox-alert: no alert.env; <unit> failed on node-small`. The node's name comes from `/etc/renox/node-name`, which `bootstrap-node.sh` writes from `--node-id`; the Linux host name follows it in brackets when the two differ.
12. **Billing rollup (#450).** `control/billing` turns the meter records into hourly usage (`meters_hourly`), which usage, quotas, the tier machine and invoices read. Nothing else runs it:
    ```
    systemctl start renox-billing.service         # one pass now
    journalctl -u renox-billing -n 5              # {"level":"info","msg":"rollup", …} lines, no "billing run failed"
    systemctl enable --now renox-billing.timer    # then every hour at :07
    ```
    It uses `CONTROL_DATABASE_URL` from `control.env`, as the control API does.

    **Backfill.** Each pass recomputes only the last 48 closed hours and the current one (`LOOKBACK_HOURS` in `control/billing/src/rollup.ts`), so hours older than that, for example after the timer was off for a few days, need one run with `--from` and `--to` in Unix milliseconds (the hours to recompute; idempotent). Run it as the unit runs, through `systemd-run` with the unit's user, `EnvironmentFile` and `WorkingDirectory`, so `control.env` never reaches the operator's shell:
    ```
    from=$(date -u -d '2026-11-01 00:00' +%s)000; to=$(date -u -d '2026-11-07 00:00' +%s)000
    systemd-run --wait --pipe --collect --unit renox-billing-backfill \
      -p User=renox-control -p Group=renox-control -p EnvironmentFile=/etc/renox/control.env \
      -p WorkingDirectory=/opt/renox/src/control/billing -p Environment=HOME=/var/lib/renox-control \
      /opt/renox/bin/bun /opt/renox/src/control/billing/src/main.ts --from "$from" --to "$to"
    ```
    It logs one `rollup` line per pass, like the timer's runs; check with the `meters_hourly` row of the health checks.

### Health checks after every change

| Check | Expect |
| --- | --- |
| `systemctl is-active renox-worker renox-control renox-tunnel` | `active` three times |
| `systemctl list-timers 'renox-*'` | the backup timer and the billing timer, each with a next run |
| `systemctl status renox-billing.service` | the last run `status=0/SUCCESS`, less than about an hour ago |
| `sudo -u postgres psql renox -c 'select to_timestamp(max(hour_start)/1000) from meters_hourly'` | the current or the previous hour once traffic has arrived (usage is not stuck at zero); `hour_start` is in Unix milliseconds |
| `nft list table inet renox_single_host` | the input chain with `tcp dport <ssh port> accept` (22, or the `--ssh-port` of step 2) and no other `tcp dport` rule |
| From another machine: `nc -z -w 3 <node address> 22`, then `80`, `443`, `5432`, `8787`, `8788` | 22 open; every other port refused or timed out |
| `ss -tlnp` on the host | nothing listening on a public address but sshd; `127.0.0.1:8787`, `8788`, `9090`, `5432`, `20241` only on loopback |
| `stat -c '%F %U:%G %a' /run/renox-edge/worker.sock` | `socket renox:renox-edge 660` |
| `curl -fsS https://api.renoxium.com/v1/healthz` | 200 through the tunnel |
| `curl -sI https://<app>.renoxium.app/` | 200 (or the app's own status) with `strict-transport-security` and `cf-ray` headers |
| `curl -sI https://dashboard.renoxium.com/` and `https://renoxium.com/` | the same, through Cloudflare for SaaS |
| `stat -c '%U:%G %a' /etc/renox/node.token /etc/renox/platform.key` | `renox:renox 400` twice |
| `journalctl -u renox-backup-db -n 5` | last night's object key and size |
| `journalctl -u renox-tunnel -n 20` | registered tunnel connections, no origin errors |

### Packages and upgrades

**Packages on a running host (#546).** Ubuntu's `needrestart` restarts every service that uses an upgraded library after an `apt` run. On `node-small`, `apt-get install sqlite3` upgraded `libsqlite3-0`, and needrestart restarted `renox-tunnel` on its own: the apps were unreachable for about 3 s. So every `apt-get` on the host runs with `NEEDRESTART_MODE=l` (list only):
```
NEEDRESTART_MODE=l apt-get install -y <package>      # or: NEEDRESTART_MODE=l apt-get upgrade
needrestart -b                                        # NEEDRESTART-SVC: lines name the services still on the old library
```
Restart the services it lists in the next maintenance window (`systemctl restart renox-tunnel`, then the health checks above). `bootstrap-node.sh --single-host` also installs `/etc/needrestart/conf.d/renox.conf` (`ops/needrestart/renox.conf`), which puts every `renox-*` service on needrestart's never-restart list (`$nrconf{override_rc}`), so a plain `apt upgrade` or an unattended upgrade lists them but does not restart them. Other services (`fail2ban`, `fwupd`) are still restarted without `NEEDRESTART_MODE=l`.

**cloudflared (#547).** When `journalctl -u renox-tunnel` says `Your version <v> is outdated. We recommend upgrading it to <new>`, that is the trigger to bump the pin: `ops/scripts/pin-cloudflared.sh <new>` and a PR with the new `ops/cloudflared.lock` (`ops/README.md`, "cloudflared"). After the merge, in a maintenance window: check out the reviewed commit in `/opt/renox/src`, run `ops/scripts/bootstrap-node.sh --single-host --no-enable --upgrade` with the install's other flags (it installs the pinned cloudflared, SHA-256 verified), then `systemctl restart renox-tunnel`. Check `/opt/renox/bin/cloudflared --version` and that `journalctl -u renox-tunnel -n 20` shows four `Registered tunnel connection` lines.

### Signing in before the dashboard exists

Step 10 deploys the dashboard as the platform tenant's app, so that tenant's sign-up, email verification and first `renox login` happen before any dashboard is up. The links the API sends point at the dashboard: `https://dashboard.renoxium.com/signup/verify#token=…` and the device page that `renox login` prints. Do the same three calls against the API instead, from the operator's workstation or the deploy checkout, with a cookie jar that is deleted afterwards:

```
api=https://api.renoxium.com
jar=$(mktemp) && chmod 0600 "$jar"

# 1. Verify the email. The token is the part after "#token=" in the link of the
#    verification mail: the URL fragment, which never reaches a server.
curl -fsS -c "$jar" -H 'content-type: application/json' -d '{"token": "<token from the link>"}' "$api/v1/account/verify"

# 2. Sign in. The answer holds the session's CSRF value; mutating calls send it as X-Renox-CSRF.
read -rs -p 'password: ' pw; echo
csrf=$(jq -n --arg e '<owner email>' --arg p "$pw" '{email: $e, password: $p}' \
  | curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' --data-binary @- "$api/v1/account/login" | jq -r .csrf)
unset pw

# 3. In a second terminal, `renox login` prints "Open … and enter the code BCDF-GHJK" and polls.
#    Approve that code with the session while it waits:
curl -fsS -b "$jar" -H "X-Renox-CSRF: $csrf" -H 'content-type: application/json' \
  -d '{"user_code": "BCDF-GHJK"}' "$api/v1/account/device/approve"
rm -f "$jar"
```

`renox login` then stores its token (90 days, the user's role) and `renox deploy` works from the deploy checkout. The session cookie is `__Host-` and `Secure`, so the calls must go to the `https://` API through the tunnel, not to `127.0.0.1:8787`. A user with a second factor gets an MFA state at login and must complete it (`/v1/account/mfa/…`) before the approval is accepted.

### Host networking

- **IPv6 egress.** If the host has an IPv6 address but its IPv6 egress is unreliable (on `node-small`, connections to Cloudflare and R2 over IPv6 were reset), outbound calls by the control API, cloudflared and the backup fail at random. Make the resolver library prefer IPv4 for every program by adding this line to `/etc/gai.conf`:
  ```
  precedence ::ffff:0:0/96  100
  ```
  It changes the order of addresses returned by `getaddrinfo`, nothing else. Visitors' IPv6 is Cloudflare's: the host needs no inbound IPv6.
- **DNS.** The control API resolves no customer DNS any more (Cloudflare validates custom hostnames); `CONTROL_DNS_SERVERS` is gone (#419).

### A host that is not empty

`firewall-single-host.sh` must own the nftables ruleset, and nothing else should listen on a public port: the single host is tunnel-only. On a host that already serves something, in this order:

1. **Keep a way in.** A second SSH session open, and the provider's console at hand.
2. **Maintenance page, if the host serves a live site.** Point the site's DNS at a page served elsewhere (for example a Cloudflare-proxied record with a static page) and wait for the old record's TTL, so visitors do not hit a closed port while you work (for an existing Renoxium host, follow "Cut-over of an existing host" instead).
3. **Stop and disable the old listeners on 80 and 443**: `ss -tlnp '( sport = :80 or sport = :443 )'` names them. For nginx: `systemctl disable --now nginx`, then `apt-get purge nginx nginx-common` once the site no longer needs it. Same for apache2, caddy or anything else in that list.
4. **Docker.** Stop and remove its containers, then `systemctl disable --now docker.service docker.socket containerd.service`. Docker adds its own iptables-nft tables (`nft list tables` shows `ip filter`, `ip nat` and others) that would stay next to the single host's rules and can forward ports past them: after Docker is stopped, remove them (`nft delete table ip nat` and so on for each table that is not `inet renox_single_host`), or reboot once Docker is disabled.
5. **ufw.** `ufw disable` and `systemctl disable ufw`; it writes its own tables too, and two firewalls on one host make step 2 unreadable.
6. Then continue with step 1 of the install. The firewall step (2) checks SSH before it changes anything; after it, only SSH answers from outside; the sites come back through the tunnel.

## Backups

### Local backups (no R2)

Without R2 the host keeps its own copies on its disk (#517); with no `R2_ENDPOINT` in `/etc/renox/secrets/r2-backup.env`, `renox-backup-db.service` takes this path. The tenant snapshot below is local in either case. On `node-small` the control dump already goes to R2 (the file has `R2_ENDPOINT`, #538), while the weekly tenant snapshot is written locally.

| What | Where (root, 0700 directories, 0600 files) | When | Keeps |
| --- | --- | --- | --- |
| Control database | `/var/backups/renox/control-db/control-db-<stamp>.dump` (`pg_dump --format=custom`, not encrypted) | nightly 02:17, `renox-backup-db.timer` | 14 days |
| Tenant files | `/var/backups/renox/tenants/<tenant>/<name>-<stamp>.db` (`sqlite3 .backup`, a consistent copy under WAL; `app.db` and the staging `<app>.db`) | Sundays 03:17 UTC, `renox-backup-tenants.timer` | 14 days |

`BACKUP_KEEP_DAYS` (default 14) sets the retention of both; the scripts are `backup-control-db.sh` and `backup-tenant-files.sh`, installed in `/opt/renox/bin` by `bootstrap-node.sh --single-host`, which also creates `/var/backups/renox`. Enable both timers with `systemctl enable --now renox-backup-db.timer renox-backup-tenants.timer`, start each service once and look at `ls -la /var/backups/renox/control-db /var/backups/renox/tenants/*`. The journal says `backup-control-db: renox -> /var/backups/renox/control-db/<file> (<bytes> bytes)` and one `backup-tenant-files:` line per tenant.

**Monthly restore drill.** `/opt/renox/bin/restore-check.sh --pg-user postgres` restores the newest control dump into the scratch database `renox_restore_check` (`createdb`, `pg_restore --no-owner --exit-on-error`, `select count(*) from tenants`, `dropdb`) and opens the newest tenant copy with `pragma quick_check`. A corrupt dump is refused before any database is touched. It exits 1 on any failure and 0 when every step it ran passes; note the date in `ops/security/keys.md`, "Drill record". `--tenants-only` and `--control-only` run one step alone.

**A disk failure is not covered until R2 is enabled.** These copies protect against a bad migration, an accidental erasure or a corrupt file, not against losing the disk.

### Which check covers which backup

| Backup | Where on `node-small` | Its check |
| --- | --- | --- |
| Control database | R2, `renoxium-backups/control-db/…dump.age` (`R2_ENDPOINT` set), age-encrypted to `/etc/renox/backup-age.pub` | "Restore drill" below, from the owner's workstation: the private key is never on the host, so the host cannot test-restore it |
| Control database, a host without R2 | `/var/backups/renox/control-db/` | `restore-check.sh --control-only` (or without flags) |
| Tenant files | `/var/backups/renox/tenants/` (weekly, `renox-backup-tenants`) | `restore-check.sh --tenants-only`; it names the snapshot it checked |

Without a flag, `restore-check.sh` on a host with `R2_ENDPOINT` and no local dump prints `restore-check: control dump is in R2; run the Restore drill from the workstation`, skips that step, and exits 0 when the tenant step passes (#538). With neither a local dump nor an R2 configuration it still exits 1. On `node-small`:
```
sudo /opt/renox/bin/restore-check.sh --pg-user postgres     # or: --tenants-only
```

### R2 backups

| What | Where | How often | Keeps |
| --- | --- | --- | --- |
| Control database | `renoxium-backups/control-db/<yyyy>/<mm>/control-db-<stamp>.dump.age` | nightly, `renox-backup-db.timer` | 30 days (lifecycle rule and bucket lock) |
| Tenant files | `renoxium-replicas/tenants/<database>/` (Litestream, one sidecar per tenant file) | WAL within `sync_interval_ms` (1 s), a snapshot hourly | 24 h of generations (`retention_hours`) |
| Artifacts | `renoxium-artifacts`; artifacts are content-addressed and re-uploadable by `renox deploy` | on deploy | while referenced |

`backup-control-db.sh` runs `pg_dump --format=custom`, pipes the dump into `age` to the public key, and uploads it with an S3 PUT that curl signs (SigV4, region `auto`). It then reads the object's size back. The R2 secret reaches curl on its standard input. A failing `pg_dump` fails the run and uploads nothing.

**Tenant files to R2** (#417; ADR D25 dropped the residency rule that blocked it):

1. **Bucket and token (owner, off the host).** In the Cloudflare dashboard create the bucket `renoxium-replicas`, then an R2 API token of its own: *Object Read & Write*, limited to that one bucket (not the artifacts or backups token). Put the pair on the host as `/etc/renox/secrets/r2-replica.env` (`install -m 0600 -o root -g root`), two lines:
   ```
   LITESTREAM_ACCESS_KEY_ID=<the token's access key id>
   LITESTREAM_SECRET_ACCESS_KEY=<the token's secret>
   ```
   systemd reads it as root into `renox-litestream@` and `renox-worker` (`EnvironmentFile=`); the worker's restore and erasure purge read the same variables. It is never in `worker.toml`, a command line or a log.
2. **Worker.** In `/etc/renox/worker.toml` uncomment the `[replication]` block of `ops/worker.toml.example`: `replica = "s3"`, `bucket = "renoxium-replicas"`, `prefix = "tenants"`, `region = "auto"`, `endpoint = "https://<account id>.r2.cloudflarestorage.com"`, `litestream_bin = "/opt/renox/bin/litestream"`. The worker refuses `region = "auto"` without `endpoint`, and the old `allowed_regions` and `sse_kms_key_id` keys. `systemctl restart renox-worker`.
3. **Check.** Write to a test app, then `journalctl -u 'renox-litestream@*' -n 20` shows the sidecar replicating, and the R2 dashboard lists objects under `tenants/<database>/`.
4. **Restore drill (a tenant file).** On a test tenant only: note a row, `systemctl stop renox-worker`, move its `app.db` aside (`mv /var/lib/renox/data/<tenant>/app.db /root/app.db.drill`), `systemctl start renox-worker`, and open the app. The worker restores a missing file from its replica before the cell opens it (`litestream restore`, newest generation; `crates/renox-cell/README.md`, "Replication"), then checks it with `PRAGMA quick_check`. The noted row is there and `journalctl -u renox-worker` names the restore. Record the date, the tenant and the time the restore took in `ops/security/keys.md`, "Drill record"; delete `/root/app.db.drill` afterwards. The same path serves `restoreBackup` (deploy API section 14) to a point in time inside the 24 h of retention.

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

Tenant file. Recorded run on 2026-11-02 with the pinned Litestream 0.3.13 in a container: a WAL-mode file with 5,000 rows plus 1,000 written while replicating was deleted, then restored in 0.04 s with 6,000 rows and `pragma quick_check` = `ok`.

```
litestream restore -config <run_dir>/litestream/<database>.yml -o /tmp/app.db.restored /var/lib/renox/data/<tenant>/app.db
sqlite3 /tmp/app.db.restored 'pragma quick_check'
```

In production the worker does this itself before it opens a missing or corrupt file (`crates/renox-cell/README.md`, "Replication").

## Cut-over of an existing host

For a host installed with the old DNS-only layout (the worker's own TLS on 443, ACME on 80, `renox-cert-renew`, `_renox-verify` TXT records), such as `node-small` in November 2026. The new worker has no TLS, so the old and new layouts cannot overlap: the cut-over is a **short maintenance window**, acceptable while there is no paying tenant (owner's plan on #420). The owner runs it, with the DNS steps; a session does not. Read the whole section first.

**Before you start.**
- **The worker release.** The new layout needs a worker without inbound TLS: `worker-v0.3.0` or newer (`crates/renox-cell` 0.3.0, #422 and #424). `worker-v0.2.x` still terminates TLS and refuses the new `worker.toml`. Check that the release exists and is signed before step 0; `--worker-version` in step 1 is its version without the `worker-v` prefix.
- **The platform apps' names.** A host installed before #396 may run the platform's apps under stopgap names (on `node-small`: `renoxium-dashboard` and `renoxium-www`, under the tenant `renoxium` raised to `paid` by hand). Keep those names through the cut-over: list them with `GET /v1/apps` and use them wherever this section says `<dashboard app>` or `<www app>`. Moving to the reserved names `dashboard` and `www` (install step 9) is a separate change after the cut-over, in three calls: mark the tenant as the platform tenant (`POST /v1/ops/tenants/renoxium/platform`, step 9.5), then, with a token of the tenant's owner, `renox apps rename renoxium-dashboard dashboard` and `renox apps rename renoxium-www www` (deploy-api.md 0.7 section 3, #537). Each app keeps its deployment, data, secrets and custom domains (still attached, the Cloudflare custom hostnames unchanged), so their custom domains keep serving without a new deploy; `renoxium-dashboard.renoxium.app` and `renoxium-www.renoxium.app` stop being served at once, and their names stay the tenant's for 90 days. The deploy checkout's `renox.toml` files already say `dashboard` and `www`, so the next `renox deploy` goes to the renamed apps. Signed-in dashboard users keep their sessions only on the custom domain; anyone who used the `renoxium.app` hostname signs in again.
- **No `edge.renoxium.app`.** ADR D26: the fallback origin and the CNAME target are the zone apex. If an earlier plan made you create an `edge` record, delete it after step 4.

**Step 0, the day before.**
- Lower the TTL of every DNS-only record the worker serves to 60 s: `renoxium.app`, `*.renoxium.app`, `renoxium.com`, `www.renoxium.com`, `dashboard.renoxium.com`. Note the current records (names, types, values) for the rollback.
- Take a control-database backup: `systemctl start renox-backup-db.service`, and note the object key from its journal line.
- Copy aside for the rollback: `cp -a /etc/renox /root/rollback-etc-renox`, `cp -a /opt/renox/bin/renox-worker /root/rollback-renox-worker`, `git -C /opt/renox/src rev-parse HEAD > /root/rollback-commit`.
- Set up Cloudflare for SaaS and its token (owner list, step 2) and the R2 replicas bucket and token (owner list, step 3); prepare the new `control.env` values (`CONTROL_CF_*`) and the new `worker.toml` (from `ops/worker.toml.example` of the new commit: the unix socket, `[gateway] trusted_socket_users`, `socket_group`, no `[tls]`).

**Step 1, the window opens.**
1. `systemctl stop renox-worker`.
2. Check out the new reviewed commit in `/opt/renox/src` and the deploy checkout, `bun install --frozen-lockfile`.
3. Run `ops/scripts/bootstrap-node.sh --single-host --no-enable --upgrade --worker-version <new> …` with the same other flags: it installs the new worker and units, the group `renox-edge`, the user `renox-tunnel` and `/run/renox-edge`. It does not overwrite `worker.toml` or `control.env`.
4. Replace `/etc/renox/worker.toml` with the new one (the old one with `[tls]` would be refused at start), and edit `/etc/renox/control.env`: add `CONTROL_CF_API_TOKEN`, `CONTROL_CF_ZONE_ID`, `CONTROL_CF_FALLBACK_ORIGIN=renoxium.app`; remove `CONTROL_EDGE_HOSTNAME`, `CONTROL_EDGE_ADDRESSES`, `CONTROL_ACME_*` and `CONTROL_DNS_SERVERS`.
5. `systemctl daemon-reload && systemctl restart renox-control`. The migrations run at start (0029 drops the certificate tables and adds the Cloudflare columns; forward-only). Check `curl -fsS http://127.0.0.1:8787/v1/healthz`.

**Step 2, the tunnel.**
1. Update `/etc/renox/tunnel/config.yml` to the ingress of `ops/cloudflared/config.yml.example` (keep the existing tunnel id `renoxium-control`): `api` and `mcp` to `127.0.0.1:8787`, `*.renoxium.app`, `renoxium.app` and the catch-all to `unix:/run/renox-edge/worker.sock`.
2. `systemctl restart renox-tunnel renox-worker`. Check `stat -c '%F %U:%G %a' /run/renox-edge/worker.sock`.

**Step 3, DNS.**
1. Make `renoxium.app` and `*.renoxium.app` proxied CNAMEs to the tunnel (no `edge.renoxium.app`, ADR D26): `cloudflared tunnel route dns renoxium-control '<name>'` for each from the owner's workstation (or replace the A/AAAA records in the dashboard).
2. Enable the Cloudflare for SaaS fallback origin `renoxium.app` and wait until it shows Active. It can only become Active after step 1 made the apex proxied. If Cloudflare refuses the apex, see owner list step 2.
3. The platform's domains: their rows from the old layout stay `verified` (served meanwhile), and the domain job creates a custom hostname for each within a minute of the restart (a pending custom hostname is not a miss). Read the records to create with `GET /v1/apps/<dashboard app>/domains/dashboard.renoxium.com` and `GET /v1/apps/<www app>/domains/{renoxium.com,www.renoxium.com}` as the platform tenant (`verification`; the app names as in "Before you start"), create those TXT records in the `renoxium.com` zone, and change the three records to DNS-only CNAMEs to `renoxium.app` (the apex by CNAME flattening). Remove the old `_renox-verify` TXT records; nothing reads them any more.

**Step 4, check from outside, through Cloudflare.** Every app name (`https://<app>.renoxium.app/` for each app of `GET /v1/ops/nodes/node-small`'s tenants), `https://renoxium.com/`, `https://www.renoxium.com/`, `https://dashboard.renoxium.com/` (sign in), `https://api.renoxium.com/v1/healthz`, and the MCP resource at `https://mcp.renoxium.com/.well-known/oauth-protected-resource` (200, JSON) or `https://mcp.renoxium.com/mcp` (the MCP endpoint itself; nothing is served at `/`). Each answers through Cloudflare (`cf-ray` header, Cloudflare's certificate), with `strict-transport-security`. A request log line in `journalctl -u renox-worker` shows the visitor's address, not `127.0.0.1`. `GET /v1/apps/<app>/domains/<hostname>` shows `status: active` for the three platform domains. Record the Orange-to-Orange result for the grey `renoxium.com` records in ADR D25, and whether Cloudflare accepted the apex as fallback origin in ADR D26. If any check fails and cannot be fixed within the window: **Rollback**.

**Step 5, only after step 4 passed.**
1. Close 80 and 443: run `ops/scripts/firewall-single-host.sh` of the new commit (same `--ssh-port`). From outside, `nc -z` on 80 and 443 fails and 22 still answers.
2. Remove the stopgaps of the old layout: `systemctl disable --now renox-cert-renew.timer renox-domain-certs.timer` (and their services); remove `/etc/systemd/system/renox-cert-renew.*`, the `renox-domain-certs` unit and script, the control API's drop-in for the ACME challenge directory, the worker's drop-in `10-net-bind.conf`, `/opt/renox/bin/lego` and `/opt/renox/bin/renew-wildcard-cert.sh`, `/etc/renox/single-host.env`, `/var/lib/renox-acme*` and `/var/lib/renox/data/_certs`; `systemctl daemon-reload`. Revoke the DNS-edit API token in the Cloudflare dashboard.
3. Raise the TTLs back (Cloudflare's "Auto" for the proxied records), remove the old A/AAAA records of the host if any are left, and delete `/root/rollback-*` after a week without problems.

**Rollback** (if step 4 fails):
1. Restore the DNS-only records noted in step 0 (the host's A/AAAA records and the old CNAMEs); with the 60 s TTL they take effect within minutes.
2. `systemctl stop renox-worker renox-control renox-tunnel`. Put back the old binary and configuration: `install -m 0755 /root/rollback-renox-worker /opt/renox/bin/renox-worker`, `rm -rf /etc/renox && cp -a /root/rollback-etc-renox /etc/renox`, and check out the commit of `/root/rollback-commit` in `/opt/renox/src` (`bun install --frozen-lockfile`).
3. The control-database migration is forward-only: restore the backup of step 0 into a fresh database ("Restore drill" above), point `CONTROL_DATABASE_URL` at it (or drop and recreate `renox` from it), then start `renox-control`.
4. Reopen 80 and 443: run `firewall-single-host.sh` of the old commit. Reinstall the old units (`bootstrap-node.sh` of the old commit with `--upgrade`), `systemctl daemon-reload`, start `renox-worker`, `renox-tunnel` and the old timers, and run the old health checks.
5. Write down what failed on #420 before trying again.

## Splitting the control plane off (before the first paying tenant)

The single host puts tenant code next to Postgres and the master key. Move the control plane to its own host before the first paying tenant, or earlier if the worker needs the whole machine (CPU or memory alerts in `ops/observability/`).

1. Set up the new host with steps 1 to 4 and 6 above (no worker). Its node listener binds a private address the worker can reach (`CONTROL_NODE_LISTEN_HOST=<private address>`), firewalled to the worker's address only.
2. Restore the newest control-database backup there, stop `renox-control` on the old host, take a last backup, restore it, and start `renox-control` on the new host.
3. **Two tunnels.** Create a second tunnel for the control plane on the new host (owner list, step 1) and route `api` and `mcp.renoxium.com` to it; remove those two rules from the worker host's ingress. The worker host keeps its tunnel for the apps and the custom hostnames. Nothing changes for clients, the CLI or the dashboard.
4. On the worker: `[control] url = "https://<private address>:8788"` (TLS between hosts), `fetch_blocked_addresses` gains the new private address, and the old `127.0.0.1` entry can stay. Restart the worker.
5. On the old host: `systemctl disable --now renox-control renox-backup-db.timer` (keep `renox-tunnel`). Remove `/etc/renox/control.env`, `/etc/renox/tunnel/credentials.json` and the backup secrets, and drop the database.

## Where this stopped (owner steps)

The sessions that wrote this page (#366, #420) had no Cloudflare, R2, Resend or Zoho account and no access to the production host. They tested every script in containers (`ops/README.md`, "Single host"), and stopped at:

- creating the tunnel, its credentials and the DNS routes (owner list, step 1);
- enabling Cloudflare for SaaS, the fallback origin, its token, and recording the plan's numbers in ADR D25 (owner list, step 2);
- the R2 buckets, lifecycle and lock rules, keys, a backup and a replica on real R2 (owner list, step 3; "Tenant files to R2");
- the backup key pair (owner list, step 4);
- Resend and Zoho, their DNS records, and the Resend key in `control.env` (owner list, step 5);
- the cut-over of `node-small` ("Cut-over of an existing host"), run by the owner after the merge.
