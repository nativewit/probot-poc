-- Per-review knowledge snapshot persistence (§4 reproducibility).
--
-- The Review row stores the identity of the knowledge content (code-review
-- skill / engineering handbook) the review STARTED with: per-source ref,
-- status, aggregate content hash and per-file sha256s. Injection reads the
-- review's own workspace copy, so a worker restart refreshing the shared
-- cache can never change an in-flight review. Nullable: standard reviews
-- (and rows predating this migration) have no knowledge snapshot.
ALTER TABLE "reviews" ADD COLUMN "knowledge_snapshot" JSONB;
