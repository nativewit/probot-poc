/*
  Warnings:

  - You are about to drop the `pings` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "installation_status" AS ENUM ('active', 'deleted');

-- CreateEnum
CREATE TYPE "repository_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "pull_request_status" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "review_state" AS ENUM ('queued', 'preparing', 'cloning', 'analyzing', 'investigating', 'validating', 'publishing', 'completed', 'completed_with_warnings', 'failed', 'cancelled', 'superseded');

-- CreateEnum
CREATE TYPE "review_trigger" AS ENUM ('opened', 'synchronized', 'ready_for_review', 'manual');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('pending_outbox', 'enqueued', 'processing', 'completed', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('pending', 'published', 'discarded');

-- DropTable
DROP TABLE "pings";

-- CreateTable
CREATE TABLE "installations" (
    "id" TEXT NOT NULL,
    "github_installation_id" BIGINT NOT NULL,
    "organization" TEXT NOT NULL,
    "status" "installation_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "github_repository_id" BIGINT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "default_branch" TEXT,
    "status" "repository_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "github_pr_number" INTEGER NOT NULL,
    "head_sha" TEXT,
    "base_sha" TEXT,
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "status" "pull_request_status" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "github_installation_id" BIGINT NOT NULL,
    "github_repository_id" BIGINT NOT NULL,
    "pull_request_number" INTEGER NOT NULL,
    "head_sha" TEXT NOT NULL,
    "base_sha" TEXT,
    "state" "review_state" NOT NULL DEFAULT 'queued',
    "trigger" "review_trigger" NOT NULL,
    "review_mode" TEXT NOT NULL DEFAULT 'standard',
    "configuration_hash" TEXT,
    "schema_version" INTEGER,
    "complexity_score" INTEGER,
    "runtime" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "superseded_by_review_id" TEXT,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_jobs" (
    "id" TEXT NOT NULL,
    "review_id" TEXT NOT NULL,
    "queue_job_id" TEXT,
    "status" "job_status" NOT NULL DEFAULT 'pending_outbox',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "job_key" TEXT NOT NULL,

    CONSTRAINT "review_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_state_transitions" (
    "id" TEXT NOT NULL,
    "review_id" TEXT NOT NULL,
    "from_state" "review_state",
    "toState" "review_state" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_state_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "review_job_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "review_job_id" TEXT,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installations_github_installation_id_key" ON "installations"("github_installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_github_repository_id_key" ON "repositories"("github_repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_full_name_key" ON "repositories"("full_name");

-- CreateIndex
CREATE INDEX "repositories_installation_id_idx" ON "repositories"("installation_id");

-- CreateIndex
CREATE INDEX "pull_requests_repository_id_idx" ON "pull_requests"("repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_repository_id_github_pr_number_key" ON "pull_requests"("repository_id", "github_pr_number");

-- CreateIndex
CREATE INDEX "reviews_pull_request_id_state_idx" ON "reviews"("pull_request_id", "state");

-- CreateIndex
CREATE INDEX "reviews_github_installation_id_github_repository_id_pull_re_idx" ON "reviews"("github_installation_id", "github_repository_id", "pull_request_number");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_pull_request_id_head_sha_review_mode_key" ON "reviews"("pull_request_id", "head_sha", "review_mode");

-- CreateIndex
CREATE UNIQUE INDEX "review_jobs_review_id_key" ON "review_jobs"("review_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_jobs_job_key_key" ON "review_jobs"("job_key");

-- CreateIndex
CREATE INDEX "review_jobs_status_idx" ON "review_jobs"("status");

-- CreateIndex
CREATE INDEX "review_state_transitions_review_id_idx" ON "review_state_transitions"("review_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_delivery_id_key" ON "webhook_deliveries"("delivery_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_delivery_id_idx" ON "webhook_deliveries"("delivery_id");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_superseded_by_review_id_fkey" FOREIGN KEY ("superseded_by_review_id") REFERENCES "reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_state_transitions" ADD CONSTRAINT "review_state_transitions_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_review_job_id_fkey" FOREIGN KEY ("review_job_id") REFERENCES "review_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_review_job_id_fkey" FOREIGN KEY ("review_job_id") REFERENCES "review_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
