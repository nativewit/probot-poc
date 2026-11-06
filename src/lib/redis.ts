import { Redis } from "ioredis";
import type { Env } from "../config/env.js";
import type { DependencyCheck } from "./prisma.js";

/**
 * Redis connectivity via ioredis.
 *
 * Connections must degrade gracefully: the client is created with offline
 * tolerance so a missing Redis does not crash the process, and
 * `checkRedis()` reports status for the readiness endpoint.
 */

let redisClient: Redis | undefined;
let redisConnectPromise: Promise<unknown> | undefined;

export function getRedis(env?: Env): Redis {
  if (!redisClient) {
    redisClient = new Redis(env?.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      // Bounded retry loop; the readiness endpoint surfaces the failure.
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
      enableOfflineQueue: false,
    });
    redisClient.on("error", () => {
      // ioredis emits 'error' on connection failures; swallow here so the
      // process never crashes on an unreachable Redis. Callers observe
      // state via checkRedis().
    });
    redisConnectPromise = redisClient.connect().catch(() => {
      // Handled via checkRedis(); never crash the process here.
    });
  }
  return redisClient;
}

/**
 * Wait up to `timeoutMs` for the initial Redis connection. Resolves even if
 * the connection never succeeds (graceful degradation); callers observe the
 * actual state via checkRedis().
 */
export async function waitRedisReady(timeoutMs = 5000): Promise<void> {
  const client = getRedis();
  const connect = redisConnectPromise ?? Promise.resolve();
  await Promise.race([
    (async () => {
      await connect;
      if (client.status !== "ready") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            client.off("ready", onReady);
            resolve();
          }, timeoutMs);
          timer.unref();
          const onReady = () => {
            clearTimeout(timer);
            resolve();
          };
          client.once("ready", onReady);
        });
      }
    })(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

/** Check Redis connectivity. Never throws. */
export async function checkRedis(): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    const client = getRedis();
    const pong = await client.ping();
    if (pong !== "PONG") {
      throw new Error(`unexpected PING response: ${pong}`);
    }
    return { status: "ok", latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: "unavailable",
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Disconnect on shutdown. Never throws. */
export async function disconnectRedis(): Promise<void> {
  try {
    await redisClient?.quit();
  } catch {
    // Connection may already be closed.
  }
}
