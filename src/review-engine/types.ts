/**
 * Review engine types and result schema contract (ARCHITECTURE.md §6, §7.1).
 *
 * The structured `ReviewResult` produced here is the contract for downstream
 * tickets: ticket 08 (finding persistence) consumes `result.findings` /
 * `result.uncertainFindings`, ticket 09 (publication) consumes the
 * inline/uncertain split and the summary.
 */

import type { ChangedFile } from "../workspace/files.js";
import type { WorkspaceResult } from "../workspace/workspace.js";

// ---------------------------------------------------------------------------
// Structured review result (§7.1 finding schema)
// ---------------------------------------------------------------------------

export const FINDING_CATEGORIES = [
  "functional",
  "regression",
  "security",
  "performance",
  "concurrency",
  "dataIntegrity",
  "errorHandling",
  "apiCompatibility",
  "maintainability",
  "testing",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "informational";

/**
 * One piece of evidence backing a finding (§1.2: every finding must carry
 * file + line + why; the reviewer must never invent evidence for a quota).
 */
export interface FindingEvidence {
  /** Workspace-relative file the evidence comes from. */
  file: string;
  /** 1-based line number in that file, when the evidence is line-anchored. */
  line?: number;
  /** Verbatim (possibly trimmed) code excerpt supporting the claim. */
  excerpt: string;
  /** Why this excerpt supports the finding. */
  reason: string;
}

export interface Finding {
  category: FindingCategory;
  severity: FindingSeverity;
  /** 0..1 as reported by the model; the engine re-derives `verified`. */
  confidence: number;
  title: string;
  /** Workspace-relative file the finding is anchored to. */
  file: string;
  /** 1-based line number in `file`. */
  line: number;
  description: string;
  /** At least one evidence reference — enforced by schema validation. */
  evidence: FindingEvidence[];
  /**
   * Derived by the ENGINE (never trusted from the model):
   * confidence >= review.confidence.minimumVerified.
   */
  verified: boolean;
}

/**
 * Structured review result (§6, §7.1). `findings` are inline-eligible
 * (confidence >= minimumInline); `uncertainFindings` go to the separate
 * summary section and are never published inline (§6.4).
 */
export interface ReviewResult {
  schemaVersion: 1;
  summary: string;
  findings: Finding[];
  uncertainFindings: Finding[];
  /** Detected project conventions relevant to the review (§6.5). */
  conventions: string[];
}

// ---------------------------------------------------------------------------
// Complexity & plan
// ---------------------------------------------------------------------------

export type ComplexityFactorName =
  | "diffSize"
  | "changedFiles"
  | "structural"
  | "dependencyImpact"
  | "riskyCode"
  | "concurrency"
  | "dataIntegrity";

export interface ComplexityFactor {
  name: ComplexityFactorName;
  /** 0..1 normalized subscore. */
  subscore: number;
  weight: number;
  /** subscore * weight. */
  contribution: number;
  /** Short human-readable explanation of what drove the subscore. */
  detail: string;
}

export type ComplexityTier = "low" | "medium" | "high";

export interface ComplexityScore {
  /** Weighted score, 0..10. */
  score: number;
  tier: ComplexityTier;
  factors: ComplexityFactor[];
}

export type StageId = "initial-analysis" | "context-investigation" | "finding-verification" | "reporting-prep";

export interface PlannedStage {
  id: StageId;
  enabled: boolean;
  /** Why the stage is enabled or skipped (planner justifications are audited). */
  justification: string;
}

export interface ReviewPlanBudgets {
  /** Upper bound on agent/model invocations for this review. */
  maxModelCalls: number;
  /** Upper bound on fulfilled repository file reads/listings. */
  maxFileRetrievals: number;
  /** Cumulative input-token budget across calls. */
  maxInputTokens: number;
  /** Per-call output-token budget. */
  maxOutputTokens: number;
  /** Whole-review timeout passed to the agent session. */
  timeoutMs: number;
}

export interface ReviewPlan {
  complexity: ComplexityScore;
  tier: ComplexityTier;
  stages: PlannedStage[];
  budgets: ReviewPlanBudgets;
}

// ---------------------------------------------------------------------------
// Retrieval trace
// ---------------------------------------------------------------------------

export interface RetrievalUsage {
  /** Tool requests the agent made (fulfilled or not). */
  requested: number;
  fulfilled: number;
  /** Requests rejected by the protocol (path escape, budget, size...). */
  rejected: number;
  /** Bytes of repository context delivered to the agent. */
  bytesDelivered: number;
  /** Security/budget violations observed (agent-attributable). */
  violations: string[];
}

export interface ModelCallUsage {
  stage: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  durationMs: number;
}

export interface ReviewRunMetadata {
  plan: ReviewPlan;
  usage: {
    modelCalls: ModelCallUsage[];
    totalInputTokens: number;
    totalOutputTokens: number;
    /** Wall-clock duration of the whole review. */
    durationMs: number;
  };
  retrieval: RetrievalUsage;
  /** Stages skipped by the planner, with justifications. */
  skippedStages: StageId[];
}

export type RunReviewOutput = {
  result: ReviewResult;
  meta: ReviewRunMetadata;
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What the engine needs to review one prepared workspace. */
export interface ReviewInput {
  reviewId: string;
  workspace: WorkspaceResult;
}

export type { ChangedFile };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Non-runtime engine failure (bad configuration, empty workspace, protocol misuse by tests). */
export class ReviewEngineError extends Error {
  constructor(
    public readonly code: "not_configured" | "empty_diff",
    message: string,
  ) {
    super(message);
    this.name = "ReviewEngineError";
  }
}
