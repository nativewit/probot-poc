-- CreateEnum
CREATE TYPE "workspace_status" AS ENUM ('active', 'cleaned', 'failed');

-- CreateTable
CREATE TABLE "review_workspaces" (
    "id" TEXT NOT NULL,
    "review_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "base_sha" TEXT,
    "merge_base_sha" TEXT,
    "status" "workspace_status" NOT NULL DEFAULT 'active',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleaned_at" TIMESTAMP(3),

    CONSTRAINT "review_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_workspaces_status_idx" ON "review_workspaces"("status");

-- CreateIndex
CREATE INDEX "review_workspaces_created_at_idx" ON "review_workspaces"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "review_workspaces_review_id_path_key" ON "review_workspaces"("review_id", "path");

-- AddForeignKey
ALTER TABLE "review_workspaces" ADD CONSTRAINT "review_workspaces_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
