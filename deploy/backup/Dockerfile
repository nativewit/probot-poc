# Backup service image — AI PR Reviewer (ticket 13, ARCHITECTURE.md §17.2).
#
# Pinned postgres image so pg_dump always matches the server major version
# (17) — pg_dump refuses cross-major restores, so keep these in sync when
# bumping the postgres service image.
#
# The container runs a simple interval loop (BACKUP_INTERVAL_HOURS) and drops
# `pg_dump -Fc` archives into the pg-backups named volume, pruning older
# files beyond BACKUP_RETENTION_DAYS. No cron daemon needed; the loop is a
# plain shell while-loop so `docker stop` interrupts it cleanly.
#
# Restore procedure: deploy/backup/restore.sh — TESTED, see
# docs/deployment.md §7.

FROM postgres:17.6-alpine

COPY backup.sh restore.sh backup-health.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/backup-health.sh

# Files land in the pg-backups volume (mounted at /backups).
VOLUME ["/backups"]

ENTRYPOINT ["/usr/local/bin/backup.sh"]
