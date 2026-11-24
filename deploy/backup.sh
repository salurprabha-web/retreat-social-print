#!/usr/bin/env bash
# Backs up the database and the photo storage of a running stack.   ./backup.sh [destination-folder]
# Writes db-<time>.dump (PostgreSQL custom format), storage-<time>.tar.gz and a SHA-256 list. Keep copies off this machine.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows would otherwise rewrite container paths
cd "$(dirname "$0")"
DEST="${1:-./backups}"; STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"; DEST="$(cd "$DEST" && pwd)"

docker compose exec -T db pg_dump -U rsp -Fc rsp > "$DEST/db-$STAMP.dump"
docker run --rm -v rsp_storage:/data:ro -v "$(cd "$DEST" && { pwd -W 2>/dev/null || pwd; })":/backup alpine tar -C /data -czf "/backup/storage-$STAMP.tar.gz" .
(cd "$DEST" && sha256sum "db-$STAMP.dump" "storage-$STAMP.tar.gz" > "SHA256-$STAMP.txt")

echo "Backup written:"; ls -l "$DEST/db-$STAMP.dump" "$DEST/storage-$STAMP.tar.gz"
echo "Checksums: $DEST/SHA256-$STAMP.txt"
