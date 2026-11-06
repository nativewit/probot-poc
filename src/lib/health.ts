import type { DependencyCheck } from "./prisma.js";
import { checkPrisma } from "./prisma.js";
import { checkRedis } from "./redis.js";

/**
 * Health and readiness logic.
 *
 * - Liveness (/healthz): the process is up and able to serve. Always 200
 *   while the event loop runs.
 * - Readiness (/readyz): reports per-dependency status (Postgres, Redis).
 *   The app starts even when dependencies are down; readiness reports them
 *   as unavailable with HTTP 503 so orchestrators can gate traffic.
 */

export type DependencyStatus = {
  name: "postgres" | "redis";
  status: "ok" | "unavailable";
  latencyMs?: number;
  error?: string;
};

export type ReadinessReport = {
  status: "ok" | "degraded";
  dependencies: DependencyStatus[];
};

export async function checkDependencies(): Promise<ReadinessReport> {
  const results = await Promise.all([
    checkPrisma() as Promise<DependencyCheck>,
    checkRedis() as Promise<DependencyCheck>,
  ]);

  const dependencies: DependencyStatus[] = [
    { name: "postgres", ...results[0] },
    { name: "redis", ...results[1] },
  ];

  const allOk = dependencies.every((dep) => dep.status === "ok");
  return { status: allOk ? "ok" : "degraded", dependencies };
}
