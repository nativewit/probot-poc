/**
 * End-to-end review pipeline wiring (ticket 09).
 *
 * Wraps the ticket 07 engine hook with the ticket 08 persistence step and the
 * ticket 09 publication step, driving the review state machine to a terminal
 * state:
 *
 *   analyzing → investigating → (engine run) → validating
 *     → findings persisted → publishing → completed | completed_with_warnings
 *
 * Failure semantics:
 *  - Findings persistence failure → `failed` (the review has no publishable
 *    data; §8.4 fail immediately).
 *  - Stale PR head at publish time → `failed` with code `stale_commit`; the
 *    results are rejected and nothing is published (§4.3/§4.4).
 *  - GitHub API failure after bounded retries → `completed_with_warnings`
 *    (the review data is retained; publication can be retried later).
 */
import type pino from "pino";
import type { PrismaClient } from "@prisma/client";
import type { AgentRuntime } from "../agent/types.js";
import type { ReviewConfig } from "../config/review-schema.js";
import { redactCredentials } from "../workspace/redact.js";
import { transitionReviewState } from "../ingestion/review-state.js";
import type { ReviewJobPayload } from "../ingestion/queue.js";
import type { WorkspaceResult } from "../workspace/workspace.js";
import type { InstallationTokenProvider } from "../workspace/credentials.js";
import { createReviewEngineHook } from "../review-engine/hook.js";
import type { RunReviewOutput } from "../review-engine/types.js";
import { persistReviewFindings } from "../findings/index.js";
import {
  StaleHeadError,
  createGitHubOctokit,
  publishReview,
  recordPublicationFailure,
  type PublisherOctokit,
} from "./publisher.js";
import { endSpan, reviewSpanAttributes, startSpan } from "../observability/tracing.js";

export interface ReviewPipelineDeps {
  runtime: AgentRuntime;
  config: ReviewConfig;
  logger: pino.Logger;
  prisma: PrismaClient;
  /** Installation-token provider used to authenticate the GitHub API calls. */
  tokenProvider: InstallationTokenProvider;
  /** Octokit factory (tests inject a fake; default builds a real one). */
  octokitFactory?: (token: string) => PublisherOctokit;
  /** Bounded retry policy for GitHub API calls. */
  publishRetry?: { maxAttempts: number; baseDelayMs: number };
}

export type ReviewPipelineHook = (ctx: {
  payload: ReviewJobPayload;
  workspace: WorkspaceResult;
}) => Promise<RunReviewOutput>;

/**
 * Persist the engine's findings and publish the review, driving the state
 * machine from `validating` to a terminal state. Exported for direct testing;
 * `createReviewPipelineHook` composes this after the engine hook.
 */
export async function finalizeReview(
  deps: ReviewPipelineDeps,
  ctx: { payload: ReviewJobPayload; workspace: WorkspaceResult },
  output: RunReviewOutput,
): Promise<void> {
  const { logger, prisma } = deps;
  const { payload, workspace } = ctx;
  const reviewId = payload.reviewId;

  // Findings persistence (ticket 08). The workspace is still present here —
  // verification needs the checked-out files; cleanup happens afterwards.
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { id: true, pullRequest: { select: { repositoryId: true } } },
  });
  if (!review) {
    throw new Error(`Review '${reviewId}' not found for findings persistence`);
  }
  try {
    await persistReviewFindings({
      repositoryId: review.pullRequest.repositoryId,
      repositoryFullName: payload.repositoryFullName,
      reviewId,
      workspacePath: workspace.workspacePath,
      findings: output.result.findings,
      uncertainFindings: output.result.uncertainFindings,
      config: deps.config,
      prisma,
      logger,
    });
  } catch (error) {
    const message = redactCredentials(error instanceof Error ? error.message : String(error));
    logger.error({ reviewId, err: message }, "Findings persistence failed");
    await transitionReviewState(reviewId, "failed", {
      errorCode: "findings_persist_failed",
      errorMessage: message.slice(0, 500),
    }).catch(() => {
      /* already terminal */
    });
    throw error;
  }

  await transitionReviewState(reviewId, "publishing");

  const publishSpan = startSpan("github.publishing", {
    attributes: reviewSpanAttributes({
      review_id: reviewId,
      repository: payload.repositoryFullName,
      pull_request_number: payload.pullRequestNumber,
      head_sha: workspace.headSha,
    }),
  });

  try {
    const token = await deps.tokenProvider.getInstallationToken(
      BigInt(payload.githubInstallationId),
      payload.repositoryFullName,
    );
    const octokit = deps.octokitFactory
      ? deps.octokitFactory(token.token)
      : createGitHubOctokit(token.token, process.env.GITHUB_BASE_URL);

    const publish = await publishReview({
      prisma,
      octokit,
      reviewId,
      repositoryFullName: payload.repositoryFullName,
      pullNumber: payload.pullRequestNumber,
      headSha: workspace.headSha,
      diff: workspace.diff,
      summary: output.result.summary,
      findings: await prisma.finding.findMany({ where: { reviewId } }).then((rows) =>
        rows.map((row) => ({
          id: row.id,
          fingerprint: row.fingerprint,
          category: row.category,
          severity: row.severity,
          confidence: row.confidence,
          title: row.title,
          filePath: row.filePath,
          lineNumber: row.lineNumber,
          description: row.description,
          verified: row.verified,
          status: row.status as "new" | "existing" | "updated" | "uncertain",
          reopened: false,
        })),
      ),
      config: {
        publishUncertainInSummary: deps.config.review.findings.publishUncertainInSummary,
        publishCleanReview: deps.config.review.reporting.publishCleanReview,
      },
      ...(deps.publishRetry ? { retry: deps.publishRetry } : {}),
      logger,
    });

    await transitionReviewState(reviewId, "completed");
    endSpan(publishSpan);
    logger.info({ reviewId, outcome: publish.outcome }, "Review pipeline completed");
  } catch (error) {
    if (error instanceof StaleHeadError) {
      // §4.3/§4.4: reject the result, publish nothing.
      endSpan(publishSpan, error);
      logger.warn({ reviewId }, "PR head moved before publication; rejecting review results");
      await transitionReviewState(reviewId, "failed", {
        errorCode: "stale_commit",
        errorMessage: redactCredentials(error.message).slice(0, 500),
      }).catch(() => {
        /* already terminal */
      });
      throw error;
    }
    endSpan(publishSpan, error);
    const message = redactCredentials(error instanceof Error ? error.message : String(error));
    logger.error({ reviewId, err: message }, "GitHub publication failed");
    await recordPublicationFailure(prisma, reviewId);
    // The review data is intact and retained; only the GitHub write failed.
    await transitionReviewState(reviewId, "completed_with_warnings").catch(() => {
      /* already terminal */
    });
  }
}

/**
 * Build the `onWorkspacePrepared` hook that runs the engine, persists the
 * findings and publishes the review to GitHub.
 */
export function createReviewPipelineHook(deps: ReviewPipelineDeps): ReviewPipelineHook {
  const engineHook = createReviewEngineHook(deps);

  return async (ctx) => {
    // Engine run + state up to `validating` (ticket 07 hook).
    const output = await engineHook(ctx);
    await finalizeReview(deps, ctx, output);
    return output;
  };
}
