import type pino from "pino";

/**
 * Review-lifecycle correlation logging (§16.1).
 *
 * Every log line emitted while a review is processed carries the full
 * correlation context: review_id, job_id, repository, pull_request_number,
 * head_sha — plus runtime/provider/model identity when known. Stage helpers
 * add `stage` and `duration_ms` automatically.
 */

export interface ReviewCorrelation {
  review_id: string;
  job_id: string;
  repository: string;
  pull_request_number: number;
  head_sha: string;
  runtime?: string;
  provider?: string;
  model?: string;
}

export type ReviewLogger = pino.Logger;

/**
 * Build a pino child logger carrying the review correlation fields. All
 * downstream pipeline log calls inherit them automatically.
 */
export function createReviewLogger(logger: pino.Logger, correlation: ReviewCorrelation): ReviewLogger {
  // Defensive: tolerate simplified logger stubs (no `child`) in tests.
  if (typeof (logger as unknown as { child?: unknown }).child !== "function") return logger;
  return logger.child(correlation);
}

/** Append runtime/provider/model identity once it is resolved mid-review. */
export function withRuntimeIdentity(
  correlation: ReviewCorrelation,
  identity: { runtime?: string; provider?: string; model?: string },
): ReviewCorrelation {
  return { ...correlation, ...identity };
}

export interface StageTracker {
  /** Log a stage completion with its duration. Returns the elapsed ms. */
  end(extra?: Record<string, unknown>): number;
}

/**
 * Start a stage timer. `stageTracker.end("clone")` logs
 * `{ stage: "clone", duration_ms: n }` at info level.
 */
export function startStage(
  logger: ReviewLogger,
  stage: string,
): StageTracker {
  const started = Date.now();
  return {
    end(extra?: Record<string, unknown>): number {
      const durationMs = Date.now() - started;
      logger.info({ stage, duration_ms: durationMs, ...(extra ?? {}) }, `Review stage completed: ${stage}`);
      return durationMs;
    },
  };
}
