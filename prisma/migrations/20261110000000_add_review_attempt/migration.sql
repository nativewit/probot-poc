-- Add review attempt discriminator so forced re-reviews (manual `/review`
-- comment) can create a new review for the same (PR, head SHA, review mode)
-- without violating the review-identity uniqueness.

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;

-- Replace the identity unique index with an attempt-aware one. Existing rows
-- keep attempt = 0, so their identity is unchanged.
DROP INDEX IF EXISTS "reviews_pull_request_id_head_sha_review_mode_key";
CREATE UNIQUE INDEX "reviews_pull_request_id_head_sha_review_mode_attempt_key" ON "reviews"("pull_request_id", "head_sha", "review_mode", "attempt");
