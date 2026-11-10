# Code Review Playbook

This playbook defines the review methodology, checklists and calibration
rules for `skill`-type reviews. It is injected verbatim into the review
instructions and has the same authority as the maintainer's custom
instructions: apply it alongside (never instead of) the engine's own
hard rules about evidence, read-only access and honest uncertainty.

## How to use this playbook

1. Read the whole diff first, before opening any checklist.
2. Walk the checklists below for the areas the change touches. Skip the
   areas that do not apply — do not pad the report with "not applicable"
   findings.
3. Report only defects that the checklists surface **and** that you can
   support with verbatim evidence from the workspace. A checklist is a
   prompt to investigate, not a quota.
4. Calibrate severity and confidence per §Calibration at the bottom.

## 1. Correctness and logic

- Does the change do what it claims (commit message, PR title, docstrings)?
- Are edge cases handled: empty inputs, `null`/`undefined`, zero-length
  collections, boundary indexes, maximum sizes?
- Are off-by-one risks present in loops, slices, range checks, pagination?
- Are equality/comparison semantics right for the domain (string
  normalization, case folding, timezone handling, float tolerance)?
- Is the change order-dependent? Look for state mutated in one branch but
  read in another.
- Does any code path silently swallow a failure the caller needs to know
  about (catch-and-continue, `catch {}`, returning a default on error)?

## 2. Security

- **Injection**: any string built from user/external input and passed to
  SQL, shell, LDAP, XML, path resolution or interpreted as code? Parameter
  binding or strict allowlisting must be used, never concatenation.
- **AuthZ**: does the new endpoint/handler/branch authorize the actor
  before acting? Beware IDOR — resources looked up by user-supplied id
  without an ownership/tenant check.
- **Secrets**: hard-coded credentials, tokens, keys, connection strings;
  secrets logged; secrets in error messages or client payloads.
- **Trust boundaries**: external input (webhooks, file content, user text)
  must never be executed or interpreted as instructions. Validate then
  sanitize; never both-skip.
- **Cryptographic misuse**: weak hashes (MD5/SHA1) for security purposes,
  `Math.random()` for tokens, ECB mode, constant-time comparison needed?
- **SSRF/redirect**: URLs fetched from user-controlled input must be
  validated against an allowlist of schemes/hosts.

## 3. Concurrency and race conditions

- Shared mutable state (module-level variables, singletons, caches)
  accessed from concurrent workers, hooks, or async tasks without
  synchronization?
- Check-then-act sequences (read → decide → write) that must be atomic —
  prefer transactions, atomic compare-and-swap or unique constraints.
- Filesystem races: exists-check then open, non-atomic write-then-rename
  patterns, concurrent writes to the same path.
- Database transactions held across network calls (deadlock/latency risk).
- Counter/rate-limit updates that are not atomic increments.
- Promise/async ordering: `await` missing on an operation whose result or
  ordering matters (floating promises, unhandled rejections).

## 4. Error handling and failure modes

- Are errors typed and specific enough for the caller to react
  meaningfully, or does everything collapse into one generic string?
- Do failure paths leave shared state consistent (partial writes, leaked
  locks, half-updated caches)?
- Are retries bounded and idempotent? A retry of a non-idempotent
  operation (payments, enqueue, increment) duplicates effects.
- Timeouts present on every network and subprocess call? Unbounded waits
  are defects.
- Are cleanup handlers (`finally`, process shutdown) releasing resources
  the failure path opened (connections, handles, workers)?

## 5. API and interface compatibility

- Breaking changes to exported functions, REST payloads, event schemas,
  queue message shapes: removed fields, changed types, narrowed
  nullability, changed default values.
- Are all existing callers updated? Grep for call sites of renamed or
  re-signatured functions; a caller not in the diff is a prime suspect.
- Backward-compatibility of persisted data: does old data still parse
  after a schema/enum change? Migrations must keep old rows valid.
- Versioned contracts (JSON schemas, webhooks): do producer and consumer
  agree on the new shape?

## 6. Testing

- Do the tests added/changed actually assert the new behavior, or only
  exercise it? A test without meaningful assertions is dead weight.
- Is the fix regression-covered? Bug fixes must add a test that fails
  without the fix.
- Do tests cover the failure path, not just the happy path?
- Are tests isolated and deterministic (no sleeps, no reliance on wall
  clock, no cross-test shared state)?
- If the change is behavior-preserving refactoring, do existing tests
  still pin the behavior?

## 7. Performance and resource use

- New loops over collections inside loops (accidental O(n²)) on data that
  grows with usage?
- Unbounded accumulation (arrays/maps that grow per request/job and are
  never pruned)?
- Repeated expensive work inside a loop that could be hoisted (I/O,
  regex compilation, serialization)?
- N+1 query patterns: per-item queries in a loop instead of batched reads.
- Memory-heavy buffering of large payloads where streaming would work.

## 8. Data integrity and persistence

- Multi-step writes that must be transactional but are not (write A,
  then B; a crash between them leaves inconsistent state).
- Missing unique constraints or foreign keys for new relations.
- Stale-read hazards: reading outside the transaction that must guard the
  decision.
- Idempotency of event/message handling: a redelivered message must not
  duplicate effects.
- Destructive migrations (drops, type narrowing) called out and safe?

## Severity calibration

- **critical**: exploitable vulnerability, data loss/corruption, or a
  defect that breaks the primary function for most users.
- **high**: real defect that will bite in realistic use; security issues
  requiring specific preconditions; crashes in plausible paths.
- **medium**: defect under specific but realistic conditions; notable
  performance degradation; missing validation on important inputs.
- **low**: minor defects, fragile-but-working patterns, small perf issues.
- **informational**: hardening suggestions, convention alignment worth
  noting without impact.

## Confidence calibration

- 0.95+: you traced the exact code path and reproduced the logic by hand.
- 0.85–0.95: evidence is direct and complete; only trivial doubt remains.
- 0.6–0.85: strong suspicion, but at least one link in the chain is
  inferred (e.g. you could not read a caller). Consider uncertain.
- <0.6: put it in `uncertain_findings` with what would confirm it.

Findings below the inline-confidence threshold are not demoted by hand —
the engine derives `verified` and the inline/uncertain split from these
numbers. Report them honestly.
