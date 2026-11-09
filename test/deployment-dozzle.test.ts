/**
 * Dozzle operations stack — Compose structure validation
 * (deploy/docker-compose.dozzle.yml).
 *
 * Dozzle is an infrastructure/operations tool, deliberately a SEPARATE
 * Compose project from the application stack. This file asserts the
 * architecture decision and the safeguards the project requires:
 *
 *   - The socket mount lives ONLY here (the main stack's §10.4 invariant
 *     and its tests stay completely unchanged — see
 *     test/deployment-compose.test.ts, which must keep passing as-is).
 *   - No host ports (Dokploy Traefik ingress over dokploy-network).
 *   - Authentication, disabled actions/shell, pinned image.
 *
 * Parsed with the `yaml` package (raw file, no compose interpolation).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const composePath = path.resolve(__dirname, "../deploy/docker-compose.dozzle.yml");
const compose = parse(readFileSync(composePath, "utf8"), { merge: true }) as {
  services: Record<string, any>;
  networks: Record<string, any>;
};

const MAIN_COMPOSE_PATH = path.resolve(__dirname, "../deploy/docker-compose.yml");

describe("dozzle compose structure (operations stack)", () => {
  it("contains only the dozzle service (separate project, not the app stack)", () => {
    expect(Object.keys(compose.services)).toEqual(["dozzle"]);
    expect(compose.services.dozzle.image).toBe("amir20/dozzle:v11.4.1");
  });

  it("mounts the Docker socket READ-ONLY, plus the generated users.yml", () => {
    const mounts = compose.services.dozzle.volumes as string[];
    expect(mounts).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    expect(mounts.some((m) => m.endsWith(":/data/users.yml:ro"))).toBe(true);
  });

  it("publishes NO host ports (expose 8080 for the Traefik ingress)", () => {
    expect("ports" in compose.services.dozzle).toBe(false);
    expect(compose.services.dozzle.expose).toEqual(["8080"]);
  });

  it("requires simple authentication and disables mutating capabilities", () => {
    const env = compose.services.dozzle.environment;
    expect(env.DOZZLE_AUTH_PROVIDER).toBe("simple");
    expect(env.DOZZLE_ENABLE_ACTIONS).toBe("false");
    expect(env.DOZZLE_ENABLE_SHELL).toBe("false");
    expect(env.DOZZLE_ENABLE_MCP).toBe("false");
  });

  it("joins ONLY the external Dokploy edge network (no internal reach into app networks)", () => {
    expect(compose.services.dozzle.networks).toEqual(["edge"]);
    expect(compose.networks.edge.external).toBe(true);
    expect(compose.networks.edge.name).toMatch(/\$\{DOKPLOY_NETWORK:-dokploy-network\}/);
  });

  it("has a healthcheck, restart policy and resource limits", () => {
    const svc = compose.services.dozzle;
    expect(svc.healthcheck.test).toEqual(["CMD", "/dozzle", "healthcheck"]);
    expect(svc.restart).toBe("unless-stopped");
    expect(svc.stop_grace_period).toBeTruthy();
    expect(svc.deploy.resources.limits.memory).toMatch(/^\d+[KMG]$/);
    expect(String(svc.deploy.resources.limits.cpus)).toBeTruthy();
  });

  it("keeps the socket mount OUT of the main application compose (§10.4 invariant intact)", () => {
    // Defense in depth: the main-stack test also asserts this; check again
    // here so the dozzle introduction cannot regress the app stack.
    const main = readFileSync(MAIN_COMPOSE_PATH, "utf8");
    expect(main.includes("docker.sock")).toBe(false);
  });

  it("documents the users.yml generation requirement (never ships credentials)", () => {
    const raw = readFileSync(composePath, "utf8");
    expect(raw).toMatch(/dozzle.*generate/); // documented generation command
    expect(raw).not.toMatch(/^\s*users:/m); // no inline user entries
    expect(raw).not.toMatch(/\$2[aby]\$/); // no baked-in credential hashes
  });
});
