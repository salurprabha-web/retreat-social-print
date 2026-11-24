# Deployment

One Docker Compose stack: `db` (PostgreSQL 16), `api`, `web` (Next.js standalone), `proxy` (Caddy, automatic HTTPS). Only the proxy publishes ports (80/443). The database, API and web containers are reachable only on the internal network. The API and web containers run read-only with all capabilities dropped; the API writes only to the `storage` volume.

## 1. Prepare
1. A Linux host with Docker (Compose v2) and a DNS name pointing at it, ports 80 and 443 open.
2. `cd deploy && cp .env.example .env` and set:
   - `POSTGRES_PASSWORD` (`openssl rand -hex 24`)
   - `SESSION_SECRET` (`openssl rand -hex 32`, at least 32 characters)
   - `PUBLIC_BASE_URL` (the https address; QR codes are built from it)
   - `SITE_ADDRESS` (the same host name; Caddy obtains the certificate itself)
3. The API **refuses to start** (see `apps/api/src/prodcheck.ts`) with a missing or short secret, placeholder or default database password, an http public address, or insecure cookies.

## 2. Start
```
cd deploy
docker compose --env-file .env up -d --build
docker compose exec api node dist/migrate-cli.js    # applies pending migrations and prints the result
docker compose exec -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a long passphrase here' api node dist/seed-admin.js
```
The first administrator is created from environment variables you supply; there is no default account. The password must satisfy the password policy (12+ characters, not common, not containing the email).

Check: `curl https://<host>/api/v1/health` returns `{"ok":true}`; sign in at `https://<host>/login`.

## 3. Operate
| Task | Command |
|---|---|
| Logs | `docker compose logs -f api` (structured JSON; cookies/tokens redacted, guest/wall links masked) |
| Update | `git pull && docker compose --env-file .env up -d --build`, then run the migrate command from step 2 (migrations are forward-only) |
| Backup | `./backup.sh /safe/place` writes `db-*.dump`, `storage-*.tar.gz`, `SHA256-*.txt`. Copy them off the machine; encrypt them. |
| Restore | `./restore.sh --yes <db-dump> <storage-tar>` (replaces current data; verifies checksums first) |
| Stop | `docker compose down` (volumes kept; add `-v` only to destroy all data) |

Back up **both** the database and the storage volume; one without the other leaves pictures without records or records without pictures (the API then answers `file_missing` for those pictures, and logs it).

## 4. Retention
Automatic deletion runs inside the API every hour. Each event has its own retention period, counted from the day the event is **archived**; set it on the event's *Data retention* tab. A legal hold stops deletion. Before deleting, the report figures are frozen so reports of old events still work. Backups taken before a deletion still contain the deleted data: apply your own backup expiry.

## 5. Settings that matter
| Variable | Meaning |
|---|---|
| `TRUST_PROXY` | number of proxies in front of the API (compose sets 1). Never expose the API port directly with this set. |
| `COOKIE_SECURE` | defaults to true in production; false is refused. |
| `LOG_LEVEL` | `info` default. |
| `STORAGE_DIR` | photo storage (the `storage` volume). |
| `PHOTO_LINK_TTL_HOURS` | lifetime of signed photo links (default 24). |

## 6. Offline venue server
See `docs/OFFLINE.md`. It runs the same API in `local` mode on a laptop at the venue and delivers data to this cloud deployment with a sync credential created in the event's settings.

## 7. Verified and not verified
Verified in this repository: the bundled production API (starts, refuses unsafe configuration, secure cookies, masked logs), the production web build and CSP in a browser, the automated security and acceptance suites. Docker image build, compose stack and backup/restore round trip: see the result recorded in `docs/ACCEPTANCE.md` (section "Deployment verification").

Not verified anywhere in software: behaviour behind your specific DNS/firewall, certificate issuance on a public host, capacity under real event load, and hardware (printers, kiosks, phones).
