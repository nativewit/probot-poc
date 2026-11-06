/**
 * Ticket 13 — production Compose structure validation (deploy/docker-compose.yml).
 *
 * These are deployment-safety invariants from ARCHITECTURE.md §18 and the
 * ticket 13 acceptance criteria, enforced statically so a careless compose
 * edit cannot silently publish the databases or mount the Docker socket.
 *
 * Parsed with the `yaml` package (raw file, no compose interpolation).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const composePath = path.resolve(__dirname, "../deploy/docker-compose.yml");
const compose = parse(readFileSync(composePath, "utf8"), { merge: true }) as {
  services: Record<string, any>;
  volumes: Record<string, unknown>;
  networks: Record<string, any>;
  secrets: Record<string, any>;
};

const LONG_RUNNING = ["probot", "worker", "postgres", "redis", "backup"];

describe("production compose structure (ticket 13)", () => {
  it("contains exactly the §18.2 service topology", () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ["backup", "migrate", "postgres", "probot", "redis", "worker"].sort(),
    );
  });

  it("publishes NO ports for postgres or redis (private by construction)", () => {
    for (const svc of ["postgres", "redis", "worker", "migrate", "backup"]) {
      expect(compose.services[svc].ports ?? [], `${svc} ports`).toEqual([]);
      expect("ports" in compose.services[svc], `${svc} has no ports key`).toBe(false);
    }
  });

  it("publishes exactly one port, on probot only, for HTTPS ingress", () => {
    expect(compose.services.probot.ports).toHaveLength(1);
    expect(String(compose.services.probot.ports[0])).toMatch(/:\s*3000$/);
  });

  it("uses named volumes for all persistent data (§17.1)", () => {
    for (const v of ["postgres-data", "redis-data", "review-workspaces", "pg-backups"]) {
      expect(compose.volumes, `volume ${v} declared`).toHaveProperty(v);
    }
    expect(compose.services.postgres.volumes.join(" ")).toContain("postgres-data:/var/lib/postgresql/data");
    expect(compose.services.redis.volumes.join(" ")).toContain("redis-data:/data");
    expect(compose.services.worker.volumes.join(" ")).toContain("review-workspaces:/app/workspaces");
    expect(compose.services.backup.volumes.join(" ")).toContain("pg-backups:/backups");
    // No host bind mounts in app services (all volume sources are named volumes).
    for (const svc of LONG_RUNNING) {
      for (const v of compose.services[svc].volumes ?? []) {
        const source = typeof v === "string" ? v.split(":")[0] : v.source;
        expect(source.startsWith("/") || source.startsWith("./") || source.startsWith("../"), `${svc} volume ${source} is not a bind mount`).toBe(false);
      }
    }
  });

  it("configures health checks on every long-running service", () => {
    for (const svc of LONG_RUNNING) {
      expect(compose.services[svc].healthcheck, `${svc} healthcheck`).toBeDefined();
      expect(compose.services[svc].healthcheck.test, `${svc} healthcheck test`).toBeTruthy();
    }
  });

  it("sets resource limits on every long-running service (§18.4)", () => {
    for (const svc of LONG_RUNNING) {
      const limits = compose.services[svc].deploy?.resources?.limits;
      expect(limits, `${svc} limits`).toBeDefined();
      expect(String(limits.cpus)).toBeTruthy();
      expect(String(limits.memory)).toMatch(/^\d+[KMG]$/);
    }
    // §18.4 starting values.
    expect(compose.services.worker.deploy.resources.limits.cpus).toBe("2.0");
    expect(compose.services.worker.deploy.resources.limits.memory).toBe("2G");
  });

  it("orders startup with health-gated depends_on + one-shot migration", () => {
    for (const svc of ["probot", "worker"]) {
      const deps = compose.services[svc].depends_on;
      expect(deps.migrate.condition).toBe("service_completed_successfully");
      expect(deps.postgres.condition).toBe("service_healthy");
      expect(deps.redis.condition).toBe("service_healthy");
    }
    expect(compose.services.migrate.command.join(" ")).toContain("prisma migrate deploy");
    expect(compose.services.migrate.depends_on.postgres.condition).toBe("service_healthy");
  });

  it("configures restart policy and graceful shutdown for long-running services", () => {
    for (const svc of LONG_RUNNING) {
      expect(compose.services[svc].restart).toBe("unless-stopped");
      expect(compose.services[svc].stop_grace_period, `${svc} stop_grace_period`).toBeTruthy();
    }
    expect(compose.services.migrate.restart).toBe("no");
  });

  it("never mounts the Docker socket (§10.4 isolation)", () => {
    const raw = readFileSync(composePath, "utf8");
    expect(raw.includes("docker.sock")).toBe(false);
    for (const svc of Object.keys(compose.services)) {
      for (const v of compose.services[svc].volumes ?? []) {
        const target = typeof v === "string" ? v.split(":")[1] : v.target;
        expect(target, `${svc} target ${target}`).not.toContain("docker.sock");
      }
    }
  });

  it("keeps secrets out of the compose file (env_file + secret file mounts)", () => {
    expect(compose.secrets.github_private_key.file).toBe("./secrets/github-app.private-key.pem");
    // Private key material is referenced by PATH only, never inline.
    expect(compose.services.probot.environment.GITHUB_PRIVATE_KEY_PATH).toBe("/run/secrets/github_private_key");
    const raw = readFileSync(composePath, "utf8");
    expect(raw).not.toMatch(/PRIVATE_KEY\s*=\s*[A-Za-z0-9+/\\-]{8,}/);
    expect(raw).not.toMatch(/POSTGRES_PASSWORD\s*=\s*\S/); // interpolated from deploy/.env only
    for (const svc of ["probot", "worker", "migrate"]) {
      expect(compose.services[svc].env_file, `${svc} uses env_file`).toContain("./.env");
    }
  });

  it("keeps the databases on an internal-only network", () => {
    const internal = compose.networks.internal;
    expect(internal.internal).toBe(true);
    for (const svc of ["postgres", "redis", "backup", "migrate"]) {
      expect(compose.services[svc].networks).toContain("internal");
      expect(compose.services[svc].networks ?? []).not.toContain("edge");
    }
    expect(compose.networks.edge.external).toBe(true); // Dokploy-managed ingress network
  });

  it("hardens the public-facing container (read-only rootfs, tmpfs)", () => {
    expect(compose.services.probot.read_only).toBe(true);
    expect(compose.services.probot.tmpfs.join(" ")).toContain("/tmp");
  });

  it("pins production image versions (no floating tags)", () => {
    expect(compose.services.postgres.image).toMatch(/^postgres:\d+\.\d+-alpine$/);
    expect(compose.services.redis.image).toMatch(/^redis:\d+\.\d+-alpine$/);
  });
});
