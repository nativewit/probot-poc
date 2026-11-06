/**
 * Zod schema for the structured review result (ARCHITECTURE.md §6, §7.1).
 *
 * This is the validation boundary between the model and the application: the
 * agent's JSON answer must parse against this schema or the review fails with
 * `invalid_output` (fail-immediately; no retries, no model switching).
 *
 * Invariants enforced here:
 * - Every finding carries at least one evidence reference (file + excerpt +
 *   why). The reviewer must never invent findings for a quota, and empty
 *   `findings` arrays are valid — a clean review is a legitimate outcome.
 * - Confidence is 0..1; category/severity come from the configured enums.
 */

import { z } from "zod";
import { FINDING_CATEGORIES } from "./types.js";

const findingEvidenceSchema = z.object({
  file: z.string().min(1).max(512),
  line: z.number().int().min(1).optional(),
  excerpt: z.string().min(1).max(2_000),
  reason: z.string().min(1).max(2_000),
});

export const findingSchema = z.object({
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(["critical", "high", "medium", "low", "informational"]),
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(300),
  file: z.string().min(1).max(512),
  line: z.number().int().min(1),
  description: z.string().min(1).max(5_000),
  evidence: z.array(findingEvidenceSchema).min(1, "every finding must carry at least one evidence reference"),
  verified: z.boolean().optional(),
});

export const reviewResultSchema = z
  .preprocess(
    (raw) => {
      // The model is shown snake_case keys in the prompt template; accept both
      // spellings so the validation boundary stays strict on content, not casing.
      if (typeof raw === "object" && raw !== null && "uncertain_findings" in raw) {
        const { uncertain_findings, ...rest } = raw as Record<string, unknown>;
        return { ...rest, uncertainFindings: uncertain_findings };
      }
      return raw;
    },
    z
      .object({
    schemaVersion: z.literal(1),
    summary: z.string().min(1).max(20_000),
    /** Inline-eligible findings. An empty array is VALID (no invented quota). */
    findings: z.array(findingSchema),
    /** Low-confidence findings; published in the summary, never inline. */
    uncertainFindings: z.array(findingSchema).default([]),
    /** Detected project conventions relevant to this review (§6.5). */
    conventions: z.array(z.string().min(1).max(500)).default([]),
  })
      .strict(),
  );

export type ParsedReviewResult = z.infer<typeof reviewResultSchema>;

/** Lenient schema for the analysis-stage answer (stage 1/2 combined call). */
export const analysisOutputSchema = z
  .object({
    objective: z.string().max(5_000).default(""),
    conventions: z.array(z.string().min(1).max(500)).default([]),
    /** Requests for additional repository context (controlled protocol). */
    tool_requests: z.array(z.unknown()).default([]),
    /** Preliminary findings; finalized (or dropped) by the reporting call. */
    preliminary_findings: z.array(z.unknown()).default([]),
    /** When true the agent claims the diff needs no additional context. */
    no_additional_context_needed: z.boolean().default(false),
  })
  .strict();

export type ParsedAnalysisOutput = z.infer<typeof analysisOutputSchema>;
