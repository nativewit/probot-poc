-- CreateEnum
CREATE TYPE "finding_lifecycle_status" AS ENUM ('new', 'existing', 'updated', 'resolved', 'dismissed', 'uncertain', 'superseded');

-- CreateTable
CREATE TABLE "findings" (
    "id" TEXT NOT NULL,
    "review_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "title" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "status" "finding_lifecycle_status" NOT NULL DEFAULT 'new',
    "reopened_from_finding_id" TEXT,
    "superseded_by_review_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding_status_transitions" (
    "id" TEXT NOT NULL,
    "finding_id" TEXT NOT NULL,
    "review_id" TEXT,
    "from_status" "finding_lifecycle_status",
    "toStatus" "finding_lifecycle_status" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_status_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "findings_repository_id_fingerprint_idx" ON "findings"("repository_id", "fingerprint");

-- CreateIndex
CREATE INDEX "findings_repository_id_status_idx" ON "findings"("repository_id", "status");

-- CreateIndex
CREATE INDEX "findings_review_id_idx" ON "findings"("review_id");

-- CreateIndex
CREATE UNIQUE INDEX "findings_repository_id_review_id_fingerprint_key" ON "findings"("repository_id", "review_id", "fingerprint");

-- CreateIndex
CREATE INDEX "finding_status_transitions_finding_id_idx" ON "finding_status_transitions"("finding_id");

-- CreateIndex
CREATE INDEX "finding_status_transitions_review_id_idx" ON "finding_status_transitions"("review_id");

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_reopened_from_finding_id_fkey" FOREIGN KEY ("reopened_from_finding_id") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding_status_transitions" ADD CONSTRAINT "finding_status_transitions_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
