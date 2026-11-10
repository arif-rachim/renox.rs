# Self-host an exported app

`renox export` gives you a directory that `renox-worker` runs on your own machine, with no Renoxium account behind it. This guide takes that directory to the app answering in a browser on a small VPS. It is for one app; the platform's own host is `ops/single-host.md`.

## 1. What you get

```sh
renox export --out ./export        # in the app's folder, or add --app <name>
```

| In the directory | What it is |
| --- | --- |
| `worker.toml` | The worker's config: listens on `127.0.0.1:8080`, every path relative to the file |
| `routes.json` | The app's hostnames (and `127.0.0.1`) pointing at the artifact |
| `artifact/<hash>/` | The code that is live now |
| `data/<tenant_id>/app.db` | The database, a plain SQLite file |
| `data/files/tenants/<tenant_id>/files/` | The stored files, under their keys |
| `data/<tenant_id>/secrets.json` | `{}`, mode 0600: you fill it in (step 5) |
| `secrets.txt` | The secret names the app declares |
| `platform.key` | New random key, mode 0600, for signing sessions and file URLs |
| `manifest.json` | What was exported, with the SHA-256 of each part |

Not included: secret values (they never leave the platform), sessions (everyone signs in again; the key is new), image variants (rebuilt on the first request), and backups.

## 2. Prerequisites

- Ubuntu 24.04 or Debian 12, x64 or arm64, 1 vCPU, 1 GB RAM.
- A domain whose DNS record points at the server, and ports 80 and 443 open.

```sh
sudo apt-get install -y curl ca-certificates sqlite3 caddy
```

## 3. Install the worker

Run the app as its own user and install the worker into that user's home:

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin renox
sudo -u renox -H sh -c 'curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.12/install.sh | sh'
sudo -u renox -H /home/renox/.renox/bin/renox-worker --version
```

The installer checks the SHA-256 of the file it installs. The last line prints `renox-worker 0.7.1`.

## 4. Put the export on the server

From your machine:

```sh
scp -rp ./export you@server:app
```

On the server:

```sh
sudo mv ~/app /home/renox/app
sudo chown -R renox:renox /home/renox/app
sudo chmod 600 /home/renox/app/platform.key /home/renox/app/data/<tenant_id>/secrets.json
```

## 5. Set the secrets

`secrets.txt` lists the names (lines starting with `#` are comments). Write one entry per name, as JSON, to `data/<tenant_id>/secrets.json`:

```json
{ "STRIPE_KEY": "sk_live_...", "SESSION_PEPPER": "..." }
```

An app that declares no secrets keeps `{}`. Keep the file owned by `renox`, mode 0600.

## 6. Run it

```sh
cd /home/renox/app
sudo -u renox /home/renox/.renox/bin/renox-worker --config worker.toml
```

The log is one JSON object per line. It shows `renox-worker listening` with `"listen":"127.0.0.1:8080"` and the number of routes. From a second terminal:

```sh
curl -H 'Host: <hostname>' http://127.0.0.1:8080/
```

You get the app's page. The worker routes by `Host`, so a request with another name is a 404. Stop it with Ctrl-C.

## 7. Put TLS in front

The worker speaks plain HTTP on loopback. Caddy takes the certificate and passes the visitor's `Host` through. `/etc/caddy/Caddyfile`:

```
<hostname> {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
}
```

```sh
sudo systemctl reload caddy
```

Cloudflare Tunnel works the same way: point the ingress rule of `ops/cloudflared/config.yml.example` for your hostname at `http://127.0.0.1:8080`.

## 8. Keep it running

`/etc/systemd/system/renox-app.service`:

```ini
[Unit]
Description=Renox app
After=network.target

[Service]
User=renox
WorkingDirectory=/home/renox/app
ExecStart=/home/renox/.renox/bin/renox-worker --config worker.toml
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now renox-app
journalctl -u renox-app -f
```

## 9. Back it up

The database is one file. `VACUUM INTO` writes a consistent copy while the app runs; run it from a systemd timer or cron, and copy the result off the machine:

```sh
cd /home/renox/app
sudo -u renox mkdir -m 700 backups
sudo -u renox sqlite3 data/<tenant_id>/app.db "VACUUM INTO 'backups/app-$(date +%F).db'"
```

Copy `data/files/` too (`rsync -a`). For continuous replication to your own bucket, set `[replication]` in `worker.toml` and install Litestream 0.3.13: [`crates/renox-cell/README.md`, "Replication"](../crates/renox-cell/README.md#replication) lists the keys.

## 10. Update the app

On your machine run `renox export --out ./export2` again. On the server, stop the service, replace `artifact/` and `routes.json` with the new ones, keep `data/`, `platform.key` and `worker.toml`, fix the owner, and start it:

```sh
sudo systemctl stop renox-app
# replace artifact/ and routes.json with the new export's, then:
sudo chown -R renox:renox /home/renox/app
sudo systemctl start renox-app
```

The new export's `data/` is a fresh copy of the platform's database: do not copy it over a self-hosted one that has taken writes.

## 11. Come back, and limits

To return to the platform, create a staging app and `renox db import <file> --app <staging-app>`; a full re-import (files and artifact) is not available yet. The worker alone has no public TLS (Caddy or a tunnel does that), no edge protection beyond `[gateway]` in `worker.toml`, and no multi-node failover: it is one process on one machine.

---

Recorded on 2026-11-10 on `ubuntu:24.04` (Ubuntu 24.04.5, x64, a container), with `renox-worker` 0.7.1 from the `cli-v0.1.12` installer. Steps 2 to 6 and the backup of step 9 ran as written (Caddy 2.6.2 from Ubuntu's archive validated this Caddyfile and, with `http://<hostname>` for the container, proxied the page with 200). `systemd-analyze verify` accepted the unit; `systemctl` itself cannot run in a container, so step 8's `enable --now` and `journalctl` and the real HTTPS certificate of step 7 were not run.
