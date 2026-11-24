#!/usr/bin/env bash
# Restores a backup made by backup.sh. DESTRUCTIVE: replaces the current database and photo storage.
#   ./restore.sh --yes <db-....dump> <storage-....tar.gz>
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows would otherwise rewrite container paths
cd "$(dirname "$0")"
if [ "${1:-}" != "--yes" ] || [ $# -ne 3 ]; then echo "usage: $0 --yes <db.dump> <storage.tar.gz>   (this REPLACES the current data)"; exit 2; fi
DB="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; ST="$(cd "$(dirname "$3")" && pwd)/$(basename "$3")"
[ -f "$DB" ] && [ -f "$ST" ] || { echo "backup files not found"; exit 1; }
SUMS="$(dirname "$DB")/SHA256-$(basename "$DB" | sed -e 's/^db-//' -e 's/\.dump$//').txt"
if [ -f "$SUMS" ]; then (cd "$(dirname "$DB")" && sha256sum -c "$(basename "$SUMS")") || { echo "checksum mismatch: the backup is damaged"; exit 1; }; fi

docker compose stop api web
docker compose exec -T db psql -U rsp -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS rsp WITH (FORCE);" -c "CREATE DATABASE rsp OWNER rsp;"
docker compose exec -T db pg_restore -U rsp -d rsp --no-owner --exit-on-error < "$DB"
docker run --rm -v rsp_storage:/data -v "$(cd "$(dirname "$ST")" && { pwd -W 2>/dev/null || pwd; })":/backup:ro alpine sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar -C /data -xzf /backup/$(basename "$ST") && chown -R 1000:1000 /data"
docker compose start api web
echo "Restore finished. Check the site, then sign in and open a recent event."
