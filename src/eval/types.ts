/**
 * Quality evaluation types (ticket 12 — §13.1, §19).
 *
 * A benchmark is a JSON fixture describing one review scenario: the files in
 * the synthetic workspace, the diff under review and the findings a competent
 * reviewer MUST surface (and, for false-positive traps and clean PRs, the
 * findings it must NOT raise). Scoring compares the engine output against the
 * expectations — the fixtures never contain secrets or repository content.
 */

import type { FindingCategory, FindingSeverity } from "../review-engine/types.js";

export interface BenchmarkFile {
  /** Workspace-relative path. */
  path: string;
  content: string;
}

export interface ExpectedFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  file: string;
  /** 1-based line the finding should anchor to. */
  line: number;
  /** Allowed |predicted - expected| deviation. Default 5 (§19.2). */
  lineTolerance?: number;
}

export interface BenchmarkCase {
  id: string;
  name: string;
  description?: string;
  files: BenchmarkFile[];
  diff: string;
  changedFiles: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  /** Findings the reviewer must surface (recall). */
  expectedFindings: ExpectedFinding[];
  /**
   * Clean-PR / false-positive-trap case: true when NO inline finding is
   * acceptable — any predicted finding counts as a false positive.
   */
  expectClean?: boolean;
}

export interface BenchmarkSuite {
  id: string;
  name: string;
  /** Benchmark version — part of the EvaluationRun identity (§19). */
  version: string;
  cases: BenchmarkCase[];
}

/** Per-case score (scoring.ts). */
export interface CaseScore {
  caseId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** precision = tp / (tp + fp), 0..1 (1 when no predictions). */
  precision: number;
  /** recall = tp / (tp + fn), 0..1 (1 when no expectations). */
  recall: number;
  /** Matched findings whose severity equals the expected severity. */
  severityAccuracy: number;
  /** Predicted findings anchored within tolerance of an expected line. */
  lineAccuracy: number;
  latencyMs: number;
  passed: boolean;
}

/** Aggregated suite score (scoring.ts). */
export interface BenchmarkScore {
  totalCases: number;
  passedCases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  severityAccuracy: number;
  lineAccuracy: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Weighted overall score in [0, 1] (see scoring.ts). */
  overall: number;
  /** True when overall >= the configured quality threshold. */
  passed: boolean;
}
