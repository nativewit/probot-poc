#!/bin/sh
# Scheduled PostgreSQL backup loop — AI PR Reviewer (§17.2).
#
# Env:
#   BACKUP_INTERVAL_HOURS  hours between backups (default 24)
#   BACKUP_RETENTION_DAYS  delete backups older than this many days (default 14)
#   BACKUP_RUN_ON_START    1 = take a backup immediately at startup (default 1)
#   PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD  standard libpq vars
#
# Archives: /backups/reviewer-YYYYmmdd-HHMMSS.dump (pg_dump custom format).
# A .last-backup stamp file records the newest successful backup as a unix
# epoch — backup-health.sh compares it against BACKUP_MAX_AGE_HOURS.

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL_SECONDS=$(( ${BACKUP_INTERVAL_HOURS:-24} * 3600 ))
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

run_backup() {
    ts="$(date -u +%Y%m%d-%H%M%S)"
    target="${BACKUP_DIR}/reviewer-${ts}.dump"
    tmp="${target}.partial"

    echo "[backup] starting pg_dump -> ${target}"
    # --no-owner/--no-privileges make the archive restore-able into a fresh
    # cluster without needing the original role. Custom format (-Fc) is
    # compressed and required for --jobs parallel restore.
    if pg_dump --no-owner --no-privileges -Fc -f "${tmp}"; then
        mv "${tmp}" "${target}"
        date +%s > "${BACKUP_DIR}/.last-backup"
        echo "[backup] OK: $(du -h "${target}" | cut -f1) ${target}"
    else
        rm -f "${tmp}"
        echo "[backup] FAILED: pg_dump exited non-zero (keeping previous backups)" >&2
        return 1
    fi
}

prune_old() {
    # Prune strictly older than RETENTION_DAYS using the file name timestamp
    # (find -mtime is fine too, but names are human-auditable).
    cutoff=$(date -u -d "${RETENTION_DAYS} days ago" +%Y%m%d-%H%M%S 2>/dev/null || \
             date -u -v-${RETENTION_DAYS}d +%Y%m%d-%H%M%S)
    for f in "${BACKUP_DIR}"/reviewer-*.dump; do
        [ -e "$f" ] || continue
        name=$(basename "$f")
        stamp=${name#reviewer-}; stamp=${stamp%.dump}
        if [ "${stamp}" \< "${cutoff}" ]; then
            rm -f "$f"
            echo "[backup] pruned ${name} (older than ${RETENTION_DAYS}d)"
        fi
    done
}

if [ "${BACKUP_RUN_ON_START:-1}" = "1" ]; then
    run_backup || true
fi

while :; do
    sleep "${INTERVAL_SECONDS}"
    run_backup || true
    prune_old
done
