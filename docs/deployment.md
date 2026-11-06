# Production Deployment (Ticket 13)

This document describes the production deployment of the AI PR Reviewer via
Docker Compose, and how to run the same stack on [Dokploy](https://dokploy.com).
It covers architecture, prerequisites, secrets, first deployment, upgrades,
backup/restore (tested — evidence below), restart recovery, and the
validation runbook (§10.4 of `docs/architecture.md`).

Related: `docs/architecture.md` §17 (deployment topology), §18 (ops),
§25 (DoD).

---

## 1. Stack topology

A single compose project (`deploy/docker-compose.yml`) runs six services:

| Service   | Image                       | Role                                            | Ports (host) |
|-----------|-----------------------------|-------------------------------------------------|--------------|
| `probot`  | `ai-pr-reviewer/app:prod`   | Probot webhook app + admin API                  | `3000` (only public port) |
| `worker`  | `ai-pr-reviewer/app:prod`   | Review worker (polls Redis queue, runs opencode) | none |
| `migrate` | `ai-pr-reviewer/app:prod`   | One-shot `prisma migrate deploy`                | none (exits 0) |
| `postgres`| `postgres:17.6-alpine`      | Relational store                                | none |
| `redis`   | `redis:7.4-alpine`          | Queue + rate limits + AOF persistence           | none |
| `backup`  | `ai-pr-reviewer/backup:prod`| Daily `pg_dump -Fc` + retention + healthcheck   | none |

Key properties (enforced by the compose file and asserted by
`test/deployment-compose.test.ts`):

- **Named volumes** (`postgres-data`, `redis-data`, `review-workspaces`,
  `pg-backups`) — never bind mounts. Postgres and Redis data survive
  container recreation and `compose down` (not `down -v`).
- **No public Postgres/Redis ports.** Only `probot` publishes `3000`.
- **Healthchecks** on postgres, redis, probot, worker, backup. `probot` and
  `worker` start only after `migrate` completes successfully and postgres and
  redis are healthy.
- **Resource limits** on every service (`deploy.resources.limits`).
- **Graceful shutdown**: PID 1 is `node` (SIGTERM reaches it); the worker
  drains in-flight reviews and reconciles incomplete reviews on restart
  (`test/recovery.test.ts`).
- **No Docker socket mounted anywhere.** The worker talks to the sandbox
  daemon via `SANDBOX_DOCKER_HOST` (remote endpoint over TCP/SSH) — see §5.
- **Secrets** come from `deploy/.env` (gitignored) and
  `deploy/secrets/*` (gitignored); compose defines them via `env_file` and
  `secrets:` file entries.

## 2. Prerequisites

- Docker Engine ≥ 24 with Compose v2 (`docker compose version`).
- ~2 GB RAM, ~10 GB disk for the stack plus workspace headroom.
- A GitHub App with the private key PEM file (tickets 01/02).
- A model-provider account (worker uses `MODEL_BASE_URL` / `MODEL_NAME`).
- On Dokploy: Dokploy ≥ v0.21 (creates the external `dokploy-network`).

## 3. Secrets and environment

1. Copy the template and fill in real values:

   ```sh
   cp deploy/.env.prod.example deploy/.env
   chmod 600 deploy/.env
   ```

2. Place the GitHub App private key at
   `deploy/secrets/github-app.private-key.pem`
   (`chmod 600`). The directory is gitignored; a `.gitkeep` keeps it in git.
3. `deploy/.env` is used **both** for compose variable interpolation and as
   `env_file` for `probot`, `worker` and `migrate`. Never commit it.
4. Required variables are declared with `:?` in the compose file, so
   `docker compose config` fails fast when something is missing.

## 4. First deployment

```sh
# Validate configuration (requires deploy/.env + the key file)
docker compose -f deploy/docker-compose.yml config -q

# Build
docker compose -f deploy/docker-compose.yml build

# Start (migrate runs first as a one-shot; probot/worker wait for it)
docker compose -f deploy/docker-compose.yml up -d

# Verify
docker compose -f deploy/docker-compose.yml ps        # all healthy, migrate Exited(0)
curl -fsS http://localhost:3000/healthz               # 200
```

Notes from the validated smoke run (2026-11-06, local Docker):

- `migrate` runs `npx prisma migrate deploy` and exits 0 in ~20 s; the app
  containers are gated on `service_completed_successfully`.
- `worker` requires `METRICS_PORT=9100` (set in compose) — its healthcheck
  fetches `http://127.0.0.1:9100/metrics`.
- Without GitHub App credentials `probot` still starts healthy but logs a
  warning and does not process webhooks (`APP_ID / PRIVATE_KEY not
  configured`). Admin API returns 503 until OAuth variables are set.
- The compose file references the external network `dokploy-network`
  (override name with `DOKPLOY_NETWORK`). Locally create it once:
  `docker network create dokploy-network`. On Dokploy it already exists.

## 5. Sandbox isolation model

- The review worker creates per-review sandbox containers that run the
  `opencode` CLI against untrusted PR diffs. They are **not** spawned via a
  mounted Docker socket — no socket mount exists anywhere in the compose
  file (asserted by tests).
- `SANDBOX_DOCKER_HOST` points the worker at a remote/sidecar Docker
  endpoint (e.g. a socket-proxy or a dedicated daemon). On Dokploy, point it
  at a locked-down docker socket proxy container or the host API endpoint
  over TLS.
- `sandbox-egress` is an internal-only compose network. If you add an
  egress-proxy sidecar, attach the sandbox containers to it so they can only
  reach approved destinations (git remotes, the model API).

## 6. Upgrades and rollbacks

```sh
git pull
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d          # re-runs migrate if needed
docker compose -f deploy/docker-compose.yml logs -f worker # watch reconciliation
```

Rollback: redeploy the previous image tag / commit. Migrations are append
only (`prisma migrate deploy` never down-migrates); take a fresh backup
before upgrading (§7) so a bad release can be restored.

## 7. Backup and restore — TESTED

### 7.1 How it works

- `backup` runs an interval loop (`BACKUP_INTERVAL_HOURS`, default 24) and
  writes `pg_dump -Fc` archives named `reviewer-YYYYmmdd-HHMMSS.dump` to the
  `pg-backups` volume, plus a `.last-backup` epoch stamp.
- Retention: archives older than `BACKUP_RETENTION_DAYS` (default 14) are
  pruned by filename timestamp.
- Healthcheck (`backup-health.sh`): fails when the newest backup is older
  than `BACKUP_MAX_AGE_HOURS` (default 26) — surfaces stale backups in
  `docker compose ps`.
- The image is built from `postgres:17.6-alpine` so `pg_dump`/`pg_restore`
  always match the server major version. Bump both together.

### 7.2 Restore procedures

**Offline (rebuild the data directory — the recovery path for a lost
cluster):**

```sh
docker compose -f deploy/docker-compose.yml stop postgres
docker run --rm --entrypoint /usr/local/bin/restore.sh \
  -v ai-pr-reviewer_pg-backups:/backups:ro \
  -v ai-pr-reviewer_postgres-data:/target \
  ai-pr-reviewer/backup:prod
docker compose -f deploy/docker-compose.yml start postgres
```

(The image ENTRYPOINT is `backup.sh`, so restore always needs
`--entrypoint /usr/local/bin/restore.sh`.)

**Online (restore into the running server, e.g. bad-data rollback):**

```sh
set -a; . deploy/.env; set +a
docker run --rm --entrypoint /usr/local/bin/restore.sh \
  --network ai-pr-reviewer_internal \
  -v ai-pr-reviewer_pg-backups:/backups:ro \
  -e PGHOST=postgres -e PGDATABASE=reviewer -e PGUSER=reviewer \
  -e PGPASSWORD="$POSTGRES_PASSWORD" \
  ai-pr-reviewer/backup:prod --online
```

### 7.3 Test evidence (2026-11-06, throwaway containers)

- **Online restore**: dump `reviewer-20261106-063738.dump` restored with
  `restore.sh --online` into a scratch `postgres:17.6-alpine` container;
  marker row inserted pre-backup read back intact after restore
  (`SELECT * FROM smoke_marker` → `ticket13-restore-evidence`).
- **Offline restore**: `restore.sh` (offline mode) rebuilt a scratch target
  volume from the same archive; booting `postgres:17.6-alpine` on that
  volume showed all 8 `_prisma_migrations` rows and the full schema
  (`audit_logs`, `finding_status_transitions`, …) — identical to the live
  database (8/8 migrations).
- **Scheduled backup**: the compose `backup` service produced
  `reviewer-20261106-063324.dump` (46 KB) on start and flipped healthy.

### 7.4 Off-host replication (operational requirement)

The `pg-backups` volume protects against container/data-directory loss but
is **not** a backup against host loss. Copy archives off-host (e.g. nightly
`rclone`/`aws s3 cp` of the volume, or Dokploy volume backup feature).

## 8. Restart recovery — verified

- `docker compose restart` (full stack): postgres, redis, probot, worker all
  returned healthy; data intact (8/8 migrations after restart).
- Redis restart alone: worker reconnected (`postgres ok, redis ok — Review
  worker ready`); AOF persistence (`redis-data` volume) preserves queued
  work.
- Worker crash recovery is covered by unit/integration tests
  (`test/recovery.test.ts`): on startup the worker reconciles incomplete
  reviews (marks orphaned reviews failed and re-enqueues where appropriate),
  so a killed worker never loses review state.

## 9. Deployment on Dokploy

1. **Create the project** in Dokploy and add a *Compose* service pointing at
   this repository (or paste `deploy/docker-compose.yml`). Dokploy creates
   the external `dokploy-network` — the compose file attaches `probot` to it
   for ingress.
2. **Environment**: paste the contents of `deploy/.env` (minus secret file
   handling) into the service's environment settings; upload the GitHub App
   private key as a file mount at
   `/run/secrets/github-app.private-key.pem` (the compose `secrets:` entry
   maps `deploy/secrets/github-app.private-key.pem` — on Dokploy mount it
   equivalently or inline the key via `GITHUB_APP_PRIVATE_KEY`).
3. **Domain / HTTPS**: in the Dokploy UI, attach a domain to the `probot`
   service on port `3000`; Dokploy's Traefik edge terminates TLS and puts the
   container on `dokploy-network`. Webhook URL is
   `https://<your-domain>/api/github/webhooks`.
4. **Deploy**, then follow §4 verification. Do not expose postgres/redis —
   they have no published ports and remain on the internal network.
5. **Backups**: replicate the `pg-backups` volume off-host (§7.4).

## 10. Validation runbook

Scenarios from architecture §10.4, with local verification status:

1. **Clean deploy** — verified: `up -d` from scratch; migrate Exited(0);
   all services healthy; only port 3000 published.
2. **GitHub App install + real PR review** — *user-environment step*: needs
   real app credentials and a live webhook URL (Dokploy). Locally probot
   starts degraded (no webhooks) by design; see probot warning log.
3. **Container restart** — verified: `compose restart` → all healthy, data
   intact.
4. **Backup + restore** — verified (§7.3): online and offline restore both
   exercised on throwaway containers.
5. **Redis restart** — verified: worker reconnects; queue persisted (AOF).
6. **Provider outage** — worker retries with backoff and marks reviews
   failed after max attempts (unit tests); alerts surface via metrics
   (`worker_failures_total`). *Live outage drill is user-environment.*
7. **Worker failure** — verified: worker container exits non-zero on config
   error and Docker restarts it (`unless-stopped`); restart reconciliation
   covered by `test/recovery.test.ts`.
8. **Config rollback** — `config/review.json` is baked into the image;
   validate with the schema (`config/schemas`) before deploy; rollback =
   redeploy previous image. *Rollback drill is user-environment.*
