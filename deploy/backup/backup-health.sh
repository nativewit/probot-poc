#!/bin/sh
# Backup healthcheck — fails (exit 1) when the newest successful backup is
# older than BACKUP_MAX_AGE_HOURS (default 26h for a 24h schedule).
# Exposed via `docker compose ps` so stale backups surface to monitoring.

set -eu

stamp_file="${BACKUP_DIR:-/backups}/.last-backup"
max_age_hours="${BACKUP_MAX_AGE_HOURS:-26}"

[ -f "$stamp_file" ] || { echo "no backup stamp"; exit 1; }
last=$(cat "$stamp_file")
now=$(date +%s)
age=$(( now - last ))
limit=$(( max_age_hours * 3600 ))

if [ "$age" -lt "$limit" ]; then
    echo "last backup ${age}s ago (max ${limit}s)"
    exit 0
fi
echo "last backup ${age}s ago exceeds ${limit}s"
exit 1
