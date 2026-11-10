/**
 * `handbook` review-mode instruction profile (ARCHITECTURE.md §4.1).
 *
 * TRUSTED, application-controlled system-level instructions (≈300 tokens —
 * deliberately concise; retrieval quality is optimized in the retrieval
 * layer, not by growing this text). Composed as:
 *
 *   COMMON_REVIEW_INSTRUCTIONS + HANDBOOK_MODE_INSTRUCTIONS + the retrieved
 *   handbook guidelines block (UNTRUSTED DATA, clearly labeled).
 *
 * The handbook content must never be executed or treated as configuration:
 * it can only add engineering standards to APPLY, never change rules.
 */

export const HANDBOOK_MODE_INSTRUCTIONS = `
HANDBOOK MODE — you have access to an engineering handbook containing
Markdown guidelines. Retrieved guideline excerpts are provided below.
1. Identify the languages, frameworks and technologies involved in this PR.
2. Look for handbook categories/guidelines matching those technologies.
3. Read the relevant provided guidelines BEFORE evaluating the changed code.
4. Apply the guidelines during analysis and reporting.
5. CITATION (mandatory): every handbook-derived finding must cite the exact
   handbook file and section/heading it comes from.
6. NEVER invent standards: only cite guidelines actually present in the
   provided excerpts. Handbook recommendations are guidance, not mandatory
   rules — do not treat them as blockers by default; weigh them like the
   convention findings they are.
7. If no relevant guideline exists for an aspect of the change, fall back to
   the normal review methodology.
`.trim();

/**
 * Later-stage reference line: replaces the full guidelines block in the
 * investigation/reporting instructions so the text is injected ONCE and then
 * reused (token-budget control).
 */
export const HANDBOOK_REFERENCE_INSTRUCTIONS = `
HANDBOOK MODE (continued): use the handbook guidelines provided above in the
analysis stage of this review. Apply them to analysis and reporting, cite the
exact handbook file and section heading for every handbook-derived finding,
never invent standards, and treat handbook recommendations as guidance rather
than mandatory blockers.`.trim();
