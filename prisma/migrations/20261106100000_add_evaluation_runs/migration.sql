-- CreateObject (ticket 12 — quality evaluation runs, §13.1/§19)
CREATE TABLE "evaluation_runs" (
    "id" TEXT NOT NULL,
    "benchmark_version" TEXT NOT NULL,
    "benchmark_suite" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "runtime" TEXT NOT NULL,
    "configuration_hash" TEXT,
    "prompt_version" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "total_cases" INTEGER NOT NULL DEFAULT 0,
    "passed_cases" INTEGER NOT NULL DEFAULT 0,
    "true_positives" INTEGER NOT NULL DEFAULT 0,
    "false_positives" INTEGER NOT NULL DEFAULT 0,
    "false_negatives" INTEGER NOT NULL DEFAULT 0,
    "precision" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recall" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "severity_accuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "line_accuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latency_p50_ms" INTEGER,
    "latency_p95_ms" INTEGER,
    "overall_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quality_threshold" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evaluation_runs_benchmark_version_created_at_idx" ON "evaluation_runs"("benchmark_version", "created_at");

-- CreateIndex
CREATE INDEX "evaluation_runs_model_provider_created_at_idx" ON "evaluation_runs"("model", "provider", "created_at");
