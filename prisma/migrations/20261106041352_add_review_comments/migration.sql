-- CreateEnum
CREATE TYPE "review_comment_type" AS ENUM ('summary', 'inline');

-- CreateEnum
CREATE TYPE "review_comment_status" AS ENUM ('published', 'failed', 'superseded');

-- CreateTable
CREATE TABLE "review_comments" (
    "id" TEXT NOT NULL,
    "review_id" TEXT NOT NULL,
    "finding_id" TEXT,
    "fingerprint" TEXT,
    "github_comment_id" BIGINT,
    "comment_type" "review_comment_type" NOT NULL,
    "status" "review_comment_status" NOT NULL DEFAULT 'published',
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_comments_review_id_idx" ON "review_comments"("review_id");

-- CreateIndex
CREATE INDEX "review_comments_finding_id_idx" ON "review_comments"("finding_id");

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
