/**
 * Review body generation (ARCHITECTURE.md §6.4, §7.4; ticket 09).
 *
 * Builds the PR review summary body and the per-finding inline comment
 * bodies. Rules:
 *  - Verified findings appear in the summary (whether or not they could be
 *    anchored inline).
 *  - Uncertain findings live in a separate section, never inline
 *    (`review.findings.publishUncertainInSummary`).
 *  - A clean review publishes a short message when
 *    `review.reporting.publishCleanReview` is enabled.
 *  - Inline bodies carry a hidden fingerprint marker so repeated publications
 *    can be reconciled against existing GitHub comments (dedup).
 */

import type { StoredFinding } from "../findings/index.js";

const MAX_BODY_CHARS = 60_000; // GitHub hard cap is 65,536.

/** Hidden marker used to reconcile a published comment with a finding fingerprint. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- ai-pr-reviewer:fingerprint:${fingerprint} -->`;
}

export function extractFingerprint(body: string): string | null {
  const match = /<!--\s*ai-pr-reviewer:fingerprint:([A-Za-z0-9:_-]+)\s*-->/.exec(body);
  return match?.[1] ?? null;
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: "🔴 critical",
  high: "🟠 high",
  medium: "🟡 medium",
  low: "🔵 low",
  informational: "⚪ informational",
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface FindingsBodyInput {
  /** Engine summary text (§7.1). */
  summary: string;
  /** Verified findings of this review (stored rows; never `uncertain`). */
  verified: StoredFinding[];
  /** Uncertain findings of this review. */
  uncertain: StoredFinding[];
  /** Fingerprints that were published inline (used for the location note). */
  inlineFingerprints?: Set<string>;
  config: { publishUncertainInSummary: boolean; publishCleanReview: boolean };
}

/** Build the review (summary) body for `createReview`. */
export function buildReviewBody(input: FindingsBodyInput): string {
  const parts: string[] = [];

  parts.push("## 🤖 AI code review\n");
  parts.push(truncate(input.summary, 10_000));

  if (input.verified.length > 0) {
    parts.push("\n### Verified findings\n");
    for (const finding of input.verified) {
      const anchored = input.inlineFingerprints?.has(finding.fingerprint);
      const location = anchored
        ? `\`${finding.filePath}:${finding.lineNumber}\` (inline comment)`
        : `\`${finding.filePath}:${finding.lineNumber}\``;
      parts.push(
        `- **${truncate(finding.title, 200)}** — ${SEVERITY_LABEL[finding.severity] ?? finding.severity}, ` +
          `confidence \`${Math.round(finding.confidence * 100)}%\` · ${location}\n` +
          `  ${truncate(finding.description, 1_000)}`,
      );
    }
  }

  if (input.config.publishUncertainInSummary && input.uncertain.length > 0) {
    parts.push("\n### ⚠️ Uncertain findings (not confirmed — for awareness only)\n");
    for (const finding of input.uncertain) {
      parts.push(
        `- **${truncate(finding.title, 200)}** — ${SEVERITY_LABEL[finding.severity] ?? finding.severity}, ` +
          `confidence \`${Math.round(finding.confidence * 100)}%\` · \`${finding.filePath}:${finding.lineNumber}\`\n` +
          `  ${truncate(finding.description, 1_000)}`,
      );
    }
    parts.push("\n_These could not be verified against the repository contents; they are listed separately and never published as inline findings._");
  }

  if (input.verified.length === 0 && input.uncertain.length === 0 && input.config.publishCleanReview) {
    parts.push("\n✅ **No verified findings in this change.** The diff passed the configured checks; no issues were identified.");
  }

  const body = parts.join("\n");
  return body.length <= MAX_BODY_CHARS ? body : `${body.slice(0, MAX_BODY_CHARS - 1)}…`;
}

/** Build the inline comment body for one finding (with dedup marker). */
export function buildInlineCommentBody(finding: StoredFinding): string {
  const body = [
    `**${truncate(finding.title, 200)}**`,
    "",
    truncate(finding.description, 4_000),
    "",
    `_Category: \`${finding.category}\` · Severity: ${SEVERITY_LABEL[finding.severity] ?? finding.severity} · Confidence: \`${Math.round(finding.confidence * 100)}%\`_`,
  ].join("\n");
  const marked = `${fingerprintMarker(finding.fingerprint)}\n${body}`;
  return marked.length <= MAX_BODY_CHARS ? marked : `${marked.slice(0, MAX_BODY_CHARS - 1)}…`;
}
