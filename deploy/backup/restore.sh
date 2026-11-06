#!/bin/sh
# PostgreSQL restore — AI PR Reviewer (§17.3). TESTED — see
# docs/deployment.md §7 for the exercised procedure and results.
#
# Usage (from the host, using the compose backup service image). NOTE: the
# image ENTRYPOINT is backup.sh, so restore.sh must be selected explicitly
# with --entrypoint:
#
#   docker run --rm --entrypoint /usr/local/bin/restore.sh \
#     -v ai-pr-reviewer_pg-backups:/backups:ro \
#     -v ai-pr-reviewer_postgres-data:/target \
#     ai-pr-reviewer/backup:prod [backup-file]
#
# With the backup volume mounted read-only and a writable target, the script
# re-initialises the postgres data directory from the chosen .dump archive.
# Stop postgres first: docker compose stop postgres.
#
# Alternative (online restore into a running server):
#
#   docker run --rm --entrypoint /usr/local/bin/restore.sh \
#     --network ai-pr-reviewer_internal \
#     -v ai-pr-reviewer_pg-backups:/backups:ro \
#     -e PGHOST=postgres -e PGDATABASE=reviewer -e PGUSER=reviewer \
#     -e PGPASSWORD="$POSTGRES_PASSWORD" \
#     ai-pr-reviewer/backup:prod --online [backup-file]

set -eu

mode="${1:-}"
[ "$mode" = "--online" ] && shift || true

BACKUP_DIR="${BACKUP_DIR:-/backups}"

# Pick the newest backup unless one is named.
if [ -n "${1:-}" ]; then
    archive="$1"
    case "$archive" in /*) ;; *) archive="${BACKUP_DIR}/${archive}";; esac
else
    archive=$(ls -1t "${BACKUP_DIR}"/reviewer-*.dump 2>/dev/null | head -n1 || true)
fi
[ -n "${archive:-}" ] && [ -f "$archive" ] || { echo "no backup archive found"; exit 1; }
echo "[restore] using $(basename "$archive")"

if [ "$mode" = "--online" ]; then
    # Restore into a running server (database must exist and be empty-ish).
    pg_restore --no-owner --no-privileges --clean --if-exists -d "$PGDATABASE" "$archive"
    echo "[restore] online restore complete"
    exit 0
fi

# Offline restore: rebuild the data directory from scratch.
target="${TARGET_DIR:-/var/lib/postgresql/data}"
PGDATA_PARENT=$(dirname "$target")
PGDATA_BASENAME=$(basename "$target")

# Init a fresh cluster owned by the postgres user (uid 70 on alpine image).
rm -rf "${target:?}"/*
chown postgres:postgres "$target"
su postgres -c "initdb -D $target -E UTF8" >/dev/null

# Start a temporary single-user-mode server, load the archive, stop it.
su postgres -c "pg_ctl -D $target -l /tmp/restore.log -o '-c listen_addresses=' -w start" >/dev/null
su postgres -c "createdb -h /var/run/postgresql reviewer" 2>/dev/null || true
pg_restore --no-owner --no-privileges --jobs 2 \
    -h /var/run/postgresql -U postgres -d reviewer "$archive"
su postgres -c "pg_ctl -D $target -w stop" >/dev/null

echo "[restore] data directory rebuilt from $(basename "$archive")"
echo "[restore] start postgres: docker compose -f deploy/docker-compose.yml start postgres"
