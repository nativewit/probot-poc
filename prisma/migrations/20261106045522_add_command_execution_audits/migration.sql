-- CreateTable
CREATE TABLE "command_execution_audits" (
    "id" TEXT NOT NULL,
    "review_id" TEXT,
    "actor" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "mode" TEXT NOT NULL,
    "sandboxed" BOOLEAN NOT NULL,
    "network_mode" TEXT NOT NULL,
    "exit_code" INTEGER,
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "disk_quota_exceeded" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER,
    "stdout_bytes" INTEGER NOT NULL DEFAULT 0,
    "stderr_bytes" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_execution_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "command_execution_audits_review_id_idx" ON "command_execution_audits"("review_id");

-- CreateIndex
CREATE INDEX "command_execution_audits_decision_idx" ON "command_execution_audits"("decision");

-- CreateIndex
CREATE INDEX "command_execution_audits_created_at_idx" ON "command_execution_audits"("created_at");
