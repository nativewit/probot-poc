-- Review type (standard | skill | handbook), ARCHITECTURE.md §4.1.
--
-- All three types can review the same PR/head SHA independently (the review
-- identity gains reviewType), while dedupe still collapses duplicates within
-- one type. reviewMode (adaptive/fixed strategy) stays independent of the
-- type. Existing rows keep review_type = 'standard', so their identity is
-- unchanged apart from the new unique component.

-- CreateEnum
CREATE TYPE "review_type" AS ENUM ('standard', 'skill', 'handbook');

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN "review_type" "review_type" NOT NULL DEFAULT 'standard';
ALTER TABLE "reviews" ADD COLUMN "publish_skipped" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "reviews" ADD COLUMN "input_tokens" INTEGER;
ALTER TABLE "reviews" ADD COLUMN "output_tokens" INTEGER;

-- Replace the identity unique index with a type-aware one. Existing rows all
-- have review_type = 'standard', so their identity is unchanged.
DROP INDEX IF EXISTS "reviews_pull_request_id_head_sha_review_mode_attempt_key";
CREATE UNIQUE INDEX "reviews_pull_request_id_head_sha_review_mode_review_type_attempt_key" ON "reviews"("pull_request_id", "head_sha", "review_mode", "review_type", "attempt");
