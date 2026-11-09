# Production Deployment (Ticket 13)

This document describes the production deployment of the AI PR Reviewer via
Docker Compose, and how to run the same stack on [Dokploy](https://dokploy.com).
It covers architecture, prerequisites, secrets, first deployment, upgrades,
backup/restore (tested — evidence below), restart recovery, an optional
Dozzle log-viewer stack, and the validation runbook (§10.4 of
`docs/architecture.md`).

Related: `docs/architecture.md` §17 (deployment topology), §18 (ops),
§25 (DoD).

---

## 1. Stack topology

A single compose project (`deploy/docker-compose.yml`) runs six services:

| Service   | Image                       | Role                                            | Ports (host) |
|-----------|-----------------------------|-------------------------------------------------|--------------|
| `probot`  | `ai-pr-reviewer/app:prod`   | Probot webhook app + admin API                  | `3000` (container, Traefik ingress) |
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
- **No host ports published at all.** Traefik (Dokploy) reaches `probot` on
  container port `3000` over the external `dokploy-network` — publishing a
  host port would claim `0.0.0.0:3000` and collide with Dokploy gateway
  endpoints. Local smoke runs use `deploy/docker-compose.local.yml`, which
  maps `127.0.0.1:3000` only.
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

2. GitHub App private key — set **one** of these in `deploy/.env`:
   - `GITHUB_PRIVATE_KEY_BASE64`: the PEM encoded as single-line base64
     (`base64 -i github-app.private-key.pem | tr -d '\n'`) — the
     deployment-friendly form for platform env tabs (Dokploy etc.);
   - `GITHUB_PRIVATE_KEY`: the raw PEM (multiline — quote it if your env
     file round-trips quoted values);
   - `GITHUB_PRIVATE_KEY_PATH`: path to a PEM file available in the
     container.
3. `deploy/.env` is used **both** for compose variable interpolation and as
   `env_file` for `probot`, `worker` and `migrate`. Never commit it.
4. Required variables are declared with `:?` in the compose file, so
   `docker compose config` fails fast when something is missing.

### Agent tracing (optional — Langfuse)

Agent-level tracing (prompts, model generations, tool calls, retries, errors,
token usage) is delegated to the
[Langfuse OpenCode plugin](https://langfuse.com/integrations/developer-tools/opencode),
not reimplemented in this application. The worker only:

1. enables the pinned plugin in the generated per-session `opencode.json`
   when `observability.langfuse.enabled` is `true` (config/review.json —
   **disabled by default**), and
2. forwards the Langfuse credentials to the isolated OpenCode child process.

Set these in `deploy/.env` (or the Dokploy environment tab) before enabling:

```sh
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
# Cloud default; set for self-hosted instances:
# LANGFUSE_BASE_URL=https://langfuse.example.com
# LANGFUSE_ENVIRONMENT=production
```

Correlation: the worker sets `LANGFUSE_USER_ID=review:<reviewId>` and passes
secret-free trace tags — `review:<reviewId>`, `repository:<owner/name>` and
`pr:<number>` — as plugin options (required because the plugin ignores
config-file tags when credentials come from the environment). The same review
id, PR and repository appear in the worker's structured (Pino) logs, so a
Langfuse trace and its worker logs can be matched directly. Correlation values
are metadata only and never enter the prompt or model request. Credentials are
passed only via
the child environment — they are never written to `opencode.json` and child
processes receive nothing outside their allowlist.

> **Privacy:** the plugin can capture prompts, model responses, reasoning
> exposed by OpenCode, and tool inputs/outputs, which may include proprietary
> source code. Enable it first on a restricted repository, and agree on
> redaction, access control and retention **before** enabling it
> production-wide. Hidden chain-of-thought is not captured by this
> application, and secrets must never be placed in `config/review.json`.

Set the credentials **before** enabling tracing: the plugin is loaded into
every review session, and missing credentials mean traces are silently lost.
Tracing export failures must never be treated as review failures, but a
misconfigured/absent plugin package should be caught in a staging review
before production rollout.

Tracing requires **OpenCode ≥ 2.2.6**: v2.2.5 silently ignores the configured
`plugins` in `opencode run` mode (no error, no traces). The `Dockerfile` pins
2.2.6 for this reason — do not downgrade it.

The plugin package is **pre-installed at image build time**
(`opencode plugin add` in the `Dockerfile`). This is required: `opencode run`
does not install a missing package plugin by itself, and every review uses an
isolated per-session `XDG_CONFIG_HOME`/`XDG_DATA_HOME`; only a long-running
OpenCode server installs missing plugins (in the background). The package is
cached under the worker user's `$HOME/.cache/opencode`. If you change the
pinned plugin version, rebuild the image so the cache matches.

Troubleshooting a missing trace:

1. Confirm the credentials are in the **worker container** (not only in your
   shell): `docker compose exec worker env | grep -c '^LANGFUSE_'` (expect 3+).
2. Confirm the plugin cache exists in the container (do **not** rely on
   `opencode plugin list`, which queries a server and may print
   "No plugins found" even when the cache is present):
   ```sh
   docker compose exec worker sh -lc 'ls ~/.cache/opencode/npm/@langfuse'
   ```
   Expect `opencode-observability-plugin@0.7.0`.
3. Confirm the worker log shows `agentTracing` with the pinned package in
   `agent_session_created`.

## 4. First deployment

```sh
# Validate configuration (requires deploy/.env + the key file)
docker compose -f deploy/docker-compose.yml config -q

# Build
docker compose -f deploy/docker-compose.yml build

# Start (migrate runs first as a one-shot; probot/worker wait for it).
# The local override maps 127.0.0.1:3000 -> probot:3000 (the production
# compose publishes no host ports; Dokploy Traefik handles ingress).
docker compose \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.local.yml \
  up -d

# Verify
docker compose \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.local.yml \
  ps                                       # all healthy, migrate Exited(0)
curl -fsS http://localhost:3000/healthz    # 200
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
2. **Environment**: paste the contents of `deploy/.env` into the service's
   environment settings. Supply the GitHub App private key inline as
   `GITHUB_PRIVATE_KEY_BASE64` (single-line base64 of the PEM —
   `base64 -i github-app.private-key.pem | tr -d '\n'`) — this avoids file
   mounts entirely, which is required on Dokploy since redeploys re-clone the
   repo and any PEM placed in the checkout would be wiped.
3. **Domain / HTTPS**: in the Dokploy UI, attach a domain to the `probot`
   service on **Container Port `3000`**; Dokploy's Traefik terminates TLS,
   adds Traefik labels at deploy time, and routes traffic to the container
   over `dokploy-network` — no host port is published (which avoids host
   port collisions with Dokploy gateway endpoints). Use **Preview Compose**
   to verify the injected labels. Webhook URL is
   `https://<your-domain>/api/github/webhooks`.
4. **Deploy**, then follow §4 verification. Do not expose postgres/redis —
   they have no published ports and remain on the internal network.
5. **Backups**: replicate the `pg-backups` volume off-host (§7.4).

## 10. Dozzle — live container log viewer (operations stack)

[Dozzle](https://dozzle.dev) gives a real-time web UI over `docker logs` for
every container on the host. It is **deliberately a separate Compose project**
(`deploy/docker-compose.dozzle.yml`, project name `ai-pr-reviewer-logs`) — an
operations tool, not an application dependency:

- The app stack's §10.4 invariant "never mount the Docker socket in the app
  stack" and its no-published-ports rule stay untouched; the socket mount
  lives only in the Dozzle project. `test/deployment-compose.test.ts` is
  unchanged; `test/deployment-dozzle.test.ts` pins the new file's structure.
- **Same daemon requirement**: Dozzle sees the containers of the host whose
  socket it reads. Deploy it on the Dokploy host itself (a second *Compose*
  service in the same Dokploy project) — not in another container, VM or
  server.

### 10.1 Deploy on Dokploy

Add a **second Compose service** in the same Dokploy project and point it at
exactly this file (do **not** include the local override):

| Setting | Value |
|---|---|
| Compose file | `deploy/docker-compose.dozzle.yml` |
| Service | `dozzle` |
| Domain → Container Port | `8080` |
| Environment | `DOZZLE_ADMIN_PASSWORD` (required) |

The file declares the project name `ai-pr-reviewer-logs`, joins the external
`dokploy-network`, and publishes no host ports. It contains three services:

- `dozzle-init` — a one-shot that generates `/data/users.yml` (bcrypt) from
  environment variables into the `dozzle-data` volume and exits.
- `dozzle` — starts only after the init succeeds.
- `dozzle-tunnel` — an outbound Cloudflare quick tunnel for hosts that cannot
  accept inbound connections (see §10.2). Remove it if you have a public IP.

**No host-side file creation or shell access is needed** — everything is
driven from Compose environment variables, so it works from the Dokploy UI.

1. **Set environment variables** on the Compose service:

   | Variable | Required | Meaning |
   |---|---|---|
   | `DOZZLE_ADMIN_PASSWORD` | yes | password for the `admin` login |
   | `DOZZLE_ADMIN_EMAIL` | no | default `admin@localhost` (avatar only) |
   | `DOZZLE_ADMIN_NAME` | no | default `Admin` |
   | `DOZZLE_FORCE_USERS` | no | `1` = regenerate `users.yml` on next deploy |

   Dozzle v11 uses the `simple` auth provider reading `/data/users.yml`; the
   old `DOZZLE_USER_*` env vars no longer exist. Without a users file, login
   fails closed: there is no anonymous access.

2. **Deploy**: create the service pointing at
   `deploy/docker-compose.dozzle.yml` and attach a domain (see §10.2). The
   init container runs first and writes the credentials into the
   `dozzle-data` named volume (which survives redeploys).
3. **Log in**: browse to the domain (e.g. `https://logs.yourdomain.com`) or,
   for a local run, `http://127.0.0.1:8080`. Dozzle redirects to `/login`;
   sign in with username **`admin`** and the password from
   `DOZZLE_ADMIN_PASSWORD`.
4. **Verify**: after logging in, confirm the `ai-pr-reviewer-*` containers
   appear in the list.

`users.yml` stores only bcrypt hashes. Changing `DOZZLE_ADMIN_PASSWORD` alone
does **not** update an existing file (the init leaves an existing
`users.yml` untouched). To rotate the password, set
`DOZZLE_FORCE_USERS=1`, redeploy, then unset it again.

Local smoke run without Dokploy/Traefik (localhost-only binding, Compose
creates a local network):

```sh
DOZZLE_ADMIN_PASSWORD='change-me' \
docker compose \
  -f deploy/docker-compose.dozzle.yml \
  -f deploy/docker-compose.dozzle.local.yml \
  up -d   # http://127.0.0.1:8080
```

### 10.2 Domain and Traefik (custom or Dokploy free domain)

A custom domain is **not required** — you can use a DNS-free
`sslip.io` name whose text contains the public IP of the Dokploy host.

- **Free `sslip.io` domain (manual, recommended)**: in the Dozzle service →
  **Domains**, *type* a hostname of the form
  `<prefix>.<public-ip-with-dashes>.sslip.io`, e.g.
  `dozzle.106-51-174-82.sslip.io` for public IP `106.51.174.82`. sslip.io
  answers with the embedded IP, so no DNS records are needed. Set:
  - **Service**: `dozzle`
  - **Container Port**: `8080`
  - **Path**: `/`
  - **HTTPS**: enabled (Let's Encrypt via Traefik)
- **Dokploy "Generate Domain"**: only use it if it produces a name containing
  an IP (e.g. `...-106-51-174-82.sslip.io`). On hosts where Dokploy cannot
  detect the public IP (VMs with shared/NAT networking, custom hostnames) it
  falls back to the machine hostname and generates names such as
  `...-omarchy-local.sslip.io`. Those contain **no IP**, so sslip.io returns
  NXDOMAIN and the URL never loads. Type the domain manually instead.
- **Custom domain**: point an `A` record at the public IP, then add it in the
  same **Domains** tab.

Requirements on the host: ports `80`/`443` reachable from the internet,
Dokploy's Traefik running (default), and the service on `dokploy-network` (the
compose file does this). If the Dokploy VM uses shared/NAT networking, forward
host ports `80` and `443` to the VM (e.g. in UTM/OrbStack/libvirt network
settings); otherwise even a valid sslip.io name cannot reach Traefik. Do
**not** add Traefik labels manually — Dokploy injects them at deploy time. The
stack publishes no host port, so the only ingress path is Traefik.

Quick external check (from anywhere):

```sh
dig +short dozzle.106-51-174-82.sslip.io   # must print the public IP
curl -I https://dozzle.106-51-174-82.sslip.io
```

#### Behind CGNAT (no public IPv4 on the router)

Many ISPs put the router behind carrier-grade NAT: the router's WAN address is
private (e.g. `10.x.x.x` / `100.64.x.x`), while the internet sees a shared
public IP. Port forwarding cannot cross that second NAT, so no domain —
`sslip.io` or custom — can reach the stack. Confirm it by checking the router's
WAN IP in its admin UI and comparing it with `curl https://api.ipify.org`; if
they differ, you are behind CGNAT.

Use the bundled outbound tunnel instead. `dozzle-tunnel` dials Cloudflare
(TCP/UDP 7844 outbound), so it needs no port forwarding:

```sh
docker logs ai-pr-reviewer-logs-dozzle-tunnel-1 2>&1 | grep -i trycloudflare
# https://<random-words>.trycloudflare.com
```

Open that URL and log in with `admin` / `DOZZLE_ADMIN_PASSWORD`. The hostname
is random and changes whenever the tunnel container is recreated; it is meant
for demos/operations, not a stable production endpoint. To disable public
access, delete the `dozzle-tunnel` service from the compose file and redeploy.
Alternatively ask the ISP for a public/static IPv4, or use a named Cloudflare
tunnel with a domain you own for a stable hostname.

Local smoke run without Dokploy/Traefik (localhost-only binding, Compose
creates a local network):

```sh
docker compose \
  -f deploy/docker-compose.dozzle.yml \
  -f deploy/docker-compose.dozzle.local.yml \
  up -d   # http://127.0.0.1:8080
```

### 10.3 Security posture and caveats

- **The Docker socket is root-equivalent on the host.** A read-only mount
  (`:ro`) restricts the file on disk, **not** the Docker API — the container
  can still exec into other containers, read their filesystems via mounts,
  etc. Treat Dozzle as privileged infrastructure.
- Mitigations in place: authentication required, `DOZZLE_ENABLE_ACTIONS`
  / `DOZZLE_ENABLE_SHELL` / `DOZZLE_ENABLE_MCP` all disabled, pinned image
  (`v11.4.1`), resource limits, socket mounted read-only.
- **Restrict the domain to admin IPs or a VPN** (firewall rule, Dokploy
  Traefik IP-allow middleware, or your edge firewall) where practical —
  auth alone should not be the only gate.
- If you want to hard-limit the API itself, front the socket with a
  read-only proxy ([tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy))
  and point Dozzle at `DOCKER_HOST=tcp://socket-proxy:2375` instead of
  mounting the socket directly.

### 10.4 Troubleshooting

- **`No users.yaml or users.yml file found.`** — `dozzle-init` did not create
  the file, usually because `DOZZLE_ADMIN_PASSWORD` was not set on the
  service (the init exits with `DOZZLE_ADMIN_PASSWORD must be set`). Check:

  ```sh
  docker logs ai-pr-reviewer-logs-dozzle-init-1
  docker volume inspect ai-pr-reviewer-logs_dozzle-data
  ```

  Then set the variable on the Dokploy Compose service and redeploy.
- **Login rejected after changing `DOZZLE_ADMIN_PASSWORD`** — the init leaves
  an existing `users.yml` untouched. Set `DOZZLE_FORCE_USERS=1`, redeploy,
  then unset it.
- **Domain does not resolve (`Could not resolve host`, NXDOMAIN)** — a
  Dokploy-generated name ending in a machine hostname
  (`...-omarchy-local.sslip.io`) contains no embedded IP, so sslip.io returns
  nothing. Delete it and add a domain manually containing the public IP
  (`dozzle.<ip-with-dashes>.sslip.io`); see §10.2. Also confirm ports
  `80`/`443` are forwarded to the VM when its network is shared/NAT.
- **`read /data/users.yml: is a directory`** — this came from bind-mounting a
  single file that did not exist. The stack now uses the `dozzle-data` named
  volume instead; if you customised the mounts, mount a directory (or the
  named volume), never a single `users.yml` path.

Credentials are generated into the named volume, so they persist across
redeploys and are never committed to git.

## 11. Validation runbook

Scenarios from architecture §10.4, with local verification status:

1. **Clean deploy** — verified: `up -d` from scratch; migrate Exited(0);
   all services healthy; no host ports published (local override adds
   127.0.0.1:3000).
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
9. **Dozzle smoke (local override)** — verified: container `healthy`,
   `/healthcheck` returns 200, unauthenticated `/` redirects to `/login`,
   login with generated credentials returns 200 (wrong password 401), and
   `down` leaves no containers or networks behind. *The env-driven
   `dozzle-init` credential flow and Dokploy/Traefik ingress are
   user-environment steps (§10).*
