import { Queue } from "bullmq";
import { Redis } from "ioredis";

/**
 * BullMQ review queue (ARCHITECTURE.md §4.4, §12.2).
 *
 * The queue lives in Redis; Postgres (Review/ReviewJob rows) is the durable
 * source of truth. Jobs are enqueued through the transactional outbox, so a
 * Redis outage never loses a review request — the outbox recovery loop
 * re-enqueues pending events.
 *
 * Concurrency is 1 (review.json queue.concurrency): reviews run one at a
 * time. The BullMQ jobId is the ReviewJob.id, which makes enqueue attempts
 * idempotent — re-enqueueing the same outbox event after a crash cannot
 * create a duplicate job.
 */

export const REVIEW_QUEUE_NAME = "review-jobs";

export type ReviewJobPayload = {
  reviewId: string;
  jobKey: string;
  githubInstallationId: string;
  githubRepositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  baseSha?: string | null;
  reviewMode: string;
  trigger: string;
  configurationHash?: string | null;
};

let queue: Queue<ReviewJobPayload> | undefined;

/**
 * Dedicated BullMQ connection. Unlike the shared health-check client
 * (src/lib/redis.ts), this one fails commands fast while disconnected
 * (enableOfflineQueue: false, bounded retries) so the outbox publisher
 * fails fast and leaves events pending instead of hanging.
 */
function createQueueConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    lazyConnect: false,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 200, 1000)),
  });
}

let connection: Redis | undefined;

export function getReviewQueue(redisUrl?: string): Queue<ReviewJobPayload> {
  if (!queue) {
    connection = createQueueConnection(redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379");
    connection.on("error", () => {
      // Swallow connection errors: callers observe enqueue results and the
      // outbox recovery loop retries. Never crash the process.
    });
    queue = new Queue<ReviewJobPayload>(REVIEW_QUEUE_NAME, { connection });
  }
  return queue;
}

export function getQueueConnection(): Redis | undefined {
  return connection;
}

export async function closeReviewQueue(): Promise<void> {
  try {
    await queue?.close();
  } catch {
    // Already closed.
  }
  queue = undefined;
  try {
    await connection?.quit();
  } catch {
    // Already disconnected.
  }
  connection = undefined;
}
