import { Probot, ProbotOctokit } from "probot";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import myProbotApp from "../src/index.js";
import { getPrisma, disconnectPrisma } from "../src/lib/prisma.js";
import { checkRedis, disconnectRedis } from "../src/lib/redis.js";
import { closeReviewQueue, getReviewQueue, getQueueConnection } from "../src/ingestion/queue.js";
import { recoverOutbox } from "../src/ingestion/outbox.js";
import { ingestManualReview, getReviewStatus } from "../src/ingestion/orchestrator.js";
import { transitionReviewState, InvalidStateTransitionError } from "../src/ingestion/review-state.js";
import type { ReviewState } from "@prisma/client";

/**
 * Ticket 03 integration tests: durable review ingestion.
 *
 * Everything runs against the local docker-compose dependencies
 * (ticket01-pg on :5432, ticket01-redis on :6379). Webhook payloads are
 * delivered through probot.receive with the shared mock private key.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, "fixtures/mock-cert.pem"), "utf-8");

// Integration tests run against the local docker-compose dependencies.
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";
process.env.REDIS_URL ??= "redis://localhost:6379";

// The ingestion path loads config/review.json, whose provider.baseURL
// references ${MODEL_BASE_URL}; provide a value so validation succeeds.
process.env.MODEL_BASE_URL ??= "http://localhost:8000";

const prisma = getPrisma();

// Webhook payload factory -----------------------------------------------------

const INSTALLATION_ID = 9901;
const REPOSITORY_ID = 5501;
const REPO_FULL_NAME = "octo-org/widget";

function pullRequestPayload(action: "opened" | "synchronize" | "ready_for_review" | "closed", overrides: Record<string, unknown> = {}) {
  const headSha = (overrides.headSha as string) ?? "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
  // Top-level overrides are applied BEFORE the pull_request block is built, so
  // a partial `pull_request` override (e.g. `{ draft: true }`) deep-merges over
  // the defaults instead of clobbering head/base.
  const prOverrides = (overrides.pull_request ?? {}) as Record<string, unknown>;
  const { pull_request: _ignored, ...topLevelOverrides } = overrides;
  void _ignored;
  return {
    action,
    installation: { id: INSTALLATION_ID },
    repository: {
      id: REPOSITORY_ID,
      full_name: REPO_FULL_NAME,
      name: "widget",
      default_branch: "main",
      owner: { login: "octo-org" },
    },
    ...topLevelOverrides,
    pull_request: {
      number: 42,
      draft: false,
      state: "open",
      user: { type: "User", login: "octocat" },
      head: { sha: headSha, ref: "feature" },
      base: { sha: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222", ref: "main" },
      ...prOverrides,
    },
  };
}

function installationPayload(installationId: number, accountLogin: string, repos: Array<{ id: number; full_name: string }>) {
  return {
    action: "created",
    installation: { id: installationId, account: { login: accountLogin } },
    repositories: repos.map((r) => ({ id: r.id, full_name: r.full_name, name: r.full_name.split("/")[1] })),
  };
}

function installationDeletedPayload(installationId: number) {
  return { action: "deleted", installation: { id: installationId, account: { login: "octo-org" } } };
}

// Database helpers -------------------------------------------------------------

async function cleanDatabase(): Promise<void> {
  // FK-safe delete order.
  await prisma.webhookDelivery.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.reviewStateTransition.deleteMany();
  await prisma.reviewJob.deleteMany();
  await prisma.reviewComment.deleteMany();
  await prisma.review.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.repository.deleteMany();
  await prisma.installation.deleteMany();
}

async function receiveDelivery(
  probot: Probot,
  event: string,
  action: string | undefined,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  await probot.receive({
    id: deliveryId,
    name: event,
    payload: { ...payload, ...(action ? { action } : {}) },
  });
}

/**
 * Ensure the BullMQ queue connection is actually connected before any
 * webhook delivery. The dedicated outbox connection fails commands fast
 * while disconnected (enableOfflineQueue: false), so a delivery arriving
 * before the TCP handshake completes would leave its outbox event pending.
 */
async function ensureQueueReady(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let conn = getQueueConnection();
    if (conn && (conn.status === "end" || conn.status === "close")) {
      // Connection gave up (e.g. after a Redis outage): recreate it.
      await closeReviewQueue();
      getReviewQueue();
      conn = getQueueConnection();
    }
    if (conn?.status === "ready") return;
    if (!conn) getReviewQueue();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("BullMQ connection did not become ready in time");
}

beforeEach(async () => {
  await cleanDatabase();
  await ensureQueueReady();
});

afterAll(async () => {
  await closeReviewQueue();
  await disconnectRedis();
  await disconnectPrisma();
});

describe("review ingestion", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = new Probot({
      appId: 123,
      privateKey,
      Octokit: ProbotOctokit.defaults((instanceOptions: any) => ({
        ...instanceOptions,
        retry: { enabled: false },
        throttle: { enabled: false },
      })),
    });
    probot.load(myProbotApp);
  });

  afterEach(async () => {
    await probot?.teardown?.();
  });

  test("pull_request.opened persists installation, repository, PR, review (queued) and enqueues the job", async () => {
    await receiveDelivery(
      probot,
      "pull_request",
      "opened",
      pullRequestPayload("opened"),
      "delivery-opened-1",
    );

    const installation = await prisma.installation.findUnique({ where: { githubInstallationId: BigInt(INSTALLATION_ID) } });
    expect(installation?.status).toBe("active");

    const repository = await prisma.repository.findUnique({ where: { githubRepositoryId: BigInt(REPOSITORY_ID) } });
    expect(repository?.fullName).toBe(REPO_FULL_NAME);
    expect(repository?.defaultBranch).toBe("main");

    const review = await prisma.review.findFirst();
    expect(review).not.toBeNull();
    expect(review!.state).toBe("queued");
    expect(review!.trigger).toBe("opened");
    expect(review!.headSha).toBe("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111");
    expect(review!.configurationHash).toMatch(/^sha256:/);
    expect(review!.schemaVersion).toBe(1);

    const job = await prisma.reviewJob.findFirst({ where: { reviewId: review!.id } });
    expect(job?.jobKey).toBe(`${INSTALLATION_ID}:${REPOSITORY_ID}:42:aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111:adaptive`);
    // Redis is up in the integration environment: the outbox publishes immediately.
    expect(job?.status).toBe("enqueued");

    const outbox = await prisma.outboxEvent.findFirst();
    expect(outbox?.status).toBe("published");

    // Initial state transition persisted.
    const transitions = await prisma.reviewStateTransition.findMany({ where: { reviewId: review!.id } });
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromState).toBeNull();
    expect(transitions[0].toState).toBe("queued");
  });

  test("duplicate webhook delivery is ignored", async () => {
    const deliveryId = "delivery-duplicate-1";
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), deliveryId);
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), deliveryId);

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(1);
    const deliveries = await prisma.webhookDelivery.findMany({ where: { deliveryId } });
    expect(deliveries).toHaveLength(1);
  });

  test("same commit delivered with a new delivery id does not create a second review (identity)", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-id-1");
    const result = await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-id-2");

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(1);
    const jobs = await prisma.reviewJob.findMany();
    expect(jobs).toHaveLength(1);
    void result;
  });

  test("synchronize supersedes the in-flight review of the previous commit (§4.4)", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-sync-1");
    const first = await prisma.review.findFirstOrThrow();
    // Push the first review into an in-flight stage so superseding is observable.
    await prisma.review.update({ where: { id: first.id }, data: { state: "analyzing" } });
    await prisma.reviewStateTransition.create({
      data: { reviewId: first.id, fromState: "queued", toState: "analyzing" },
    });

    const newSha = "cccc3333cccc3333cccc3333cccc3333cccc3333";
    await receiveDelivery(
      probot,
      "pull_request",
      "synchronize",
      pullRequestPayload("synchronize", { headSha: newSha }),
      "delivery-sync-2",
    );

    const reviews = await prisma.review.findMany({ orderBy: { createdAt: "asc" } });
    expect(reviews).toHaveLength(2);
    expect(reviews[0].state).toBe("superseded");
    expect(reviews[0].supersededByReviewId).toBe(reviews[1].id);
    expect(reviews[1].headSha).toBe(newSha);
    expect(reviews[1].state).toBe("queued");

    const firstJob = await prisma.reviewJob.findFirstOrThrow({ where: { reviewId: reviews[0].id } });
    expect(firstJob.status).toBe("superseded");
    const firstOutbox = await prisma.outboxEvent.findMany({ where: { reviewJobId: firstJob.id } });
    // Pending events of a superseded job are discarded; events already
    // published stay published — the superseded job status is what the
    // worker must honor (§4.4).
    expect(firstOutbox.every((event) => event.status !== "pending")).toBe(true);

    // Transitions for the superseded review were persisted.
    const transitions = await prisma.reviewStateTransition.findMany({
      where: { reviewId: reviews[0].id },
      orderBy: { createdAt: "asc" },
    });
    expect(transitions.map((t) => t.toState)).toEqual(["queued", "analyzing", "superseded"]);
  });

  test("ready_for_review triggers a review with the ready_for_review trigger", async () => {
    await receiveDelivery(probot, "pull_request", "ready_for_review", pullRequestPayload("ready_for_review"), "delivery-rfr-1");

    const review = await prisma.review.findFirstOrThrow();
    expect(review.trigger).toBe("ready_for_review");
    expect(review.state).toBe("queued");
  });

  test("draft pull requests are skipped while github.draftPullRequests.enabled is false", async () => {
    await receiveDelivery(
      probot,
      "pull_request",
      "opened",
      pullRequestPayload("opened", { pull_request: { draft: true } }),
      "delivery-draft-1",
    );

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(0);
  });

  test("bot-authored pull requests are skipped", async () => {
    await receiveDelivery(
      probot,
      "pull_request",
      "opened",
      pullRequestPayload("opened", {
        pull_request: { user: { type: "Bot", login: "dependabot[bot]" } },
      }),
      "delivery-bot-1",
    );

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(0);
  });

  test("unsupported pull_request actions are ignored", async () => {
    await receiveDelivery(probot, "pull_request", "closed", pullRequestPayload("closed"), "delivery-closed-1");
    await receiveDelivery(probot, "pull_request", "labeled", pullRequestPayload("closed"), "delivery-labeled-1");

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(0);
    const jobs = await prisma.reviewJob.findMany();
    expect(jobs).toHaveLength(0);
  });

  test("installation.created registers installation + repositories; installation.deleted disables them", async () => {
    await receiveDelivery(
      probot,
      "installation",
      "created",
      installationPayload(9902, "octo-org", [
        { id: 6601, full_name: "octo-org/alpha" },
        { id: 6602, full_name: "octo-org/beta" },
      ]),
      "delivery-install-1",
    );

    const installation = await prisma.installation.findUniqueOrThrow({ where: { githubInstallationId: BigInt(9902) } });
    expect(installation.organization).toBe("octo-org");
    expect(installation.status).toBe("active");
    const repos = await prisma.repository.findMany({ where: { installationId: installation.id } });
    expect(repos.map((r) => r.fullName).sort()).toEqual(["octo-org/alpha", "octo-org/beta"]);

    await receiveDelivery(probot, "installation", "deleted", installationDeletedPayload(9902), "delivery-install-2");
    const deleted = await prisma.installation.findUniqueOrThrow({ where: { githubInstallationId: BigInt(9902) } });
    expect(deleted.status).toBe("deleted");
    const disabled = await prisma.repository.findMany({ where: { installationId: installation.id } });
    expect(disabled.every((r) => r.status === "disabled")).toBe(true);
  });

  test("manual ingestion creates a manual review and status lookup reports job + transitions", async () => {
    await receiveDelivery(probot, "installation", "created", installationPayload(9903, "octo-org", [{ id: 6603, full_name: "octo-org/gamma" }]), "delivery-manual-0");

    // Seed a PR for the repository (manual ingestion reviews an existing PR).
    const repository = await prisma.repository.findUniqueOrThrow({ where: { githubRepositoryId: BigInt(6603) } });
    const pullRequest = await prisma.pullRequest.create({
      data: {
        repositoryId: repository.id,
        githubPrNumber: 7,
        headSha: "dddd4444dddd4444dddd4444dddd4444dddd4444",
        status: "open",
      },
    });

    const result = await ingestManualReview({ repository: "octo-org/gamma", pullRequestNumber: 7 });
    expect(result.outcome).toBe("created");
    expect(result.reviewId).toBeDefined();

    const review = await prisma.review.findUniqueOrThrow({ where: { id: result.reviewId! } });
    expect(review.trigger).toBe("manual");
    expect(review.pullRequestId).toBe(pullRequest.id);

    const status = await getReviewStatus(result.reviewId!);
    expect(status?.review.state).toBe("queued");
    expect(status?.job?.jobKey).toContain(":7:dddd4444dddd4444dddd4444dddd4444dddd4444:adaptive");
    expect(status?.transitions).toHaveLength(1);

    // Unknown repository -> ManualIngestionError surface
    await expect(ingestManualReview({ repository: "octo-org/missing", pullRequestNumber: 1 })).rejects.toMatchObject({
      name: "ManualIngestionError",
    });

    await expect(getReviewStatus("nonexistent-id")).resolves.toBeNull();
  });
});

describe("review state machine", () => {
  test("rejects transitions out of terminal states", async () => {
    const repository = await prisma.repository.create({
      data: { githubRepositoryId: BigInt(7701), installationId: (await prisma.installation.create({ data: { githubInstallationId: BigInt(8801), organization: "org" } })).id, fullName: "org/terminal" },
    });
    const pullRequest = await prisma.pullRequest.create({
      data: { repositoryId: repository.id, githubPrNumber: 1, headSha: "eeee5555eeee5555eeee5555eeee5555eeee5555" },
    });
    const review = await prisma.review.create({
      data: {
        pullRequestId: pullRequest.id,
        githubInstallationId: BigInt(8801),
        githubRepositoryId: BigInt(7701),
        pullRequestNumber: 1,
        headSha: "eeee5555eeee5555eeee5555eeee5555eeee5555",
        trigger: "opened",
        state: "completed",
      },
    });

    await expect(transitionReviewState(review.id, "preparing" as ReviewState)).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );
    await expect(transitionReviewState(review.id, "superseded" as ReviewState)).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );

    // Valid transition still works from a non-terminal state.
    const review2 = await prisma.review.create({
      data: {
        pullRequestId: pullRequest.id,
        githubInstallationId: BigInt(8801),
        githubRepositoryId: BigInt(7701),
        pullRequestNumber: 1,
        headSha: "ffff6666ffff6666ffff6666ffff6666ffff6666",
        trigger: "opened",
      },
    });
    const moved = await transitionReviewState(review2.id, "preparing" as ReviewState);
    expect(moved.state).toBe("preparing");
    const transitions = await prisma.reviewStateTransition.findMany({ where: { reviewId: review2.id }, orderBy: { createdAt: "asc" } });
    expect(transitions.map((t) => t.toState)).toEqual(["preparing"]);
  });
});

describe("transactional outbox recovery (§12.2)", () => {
  test("ingestion with Redis down leaves pending outbox events; recovery publishes them", async () => {
    // Stop Redis so the enqueue fails and the event stays pending.
    await shell("docker stop ticket01-redis");
    try {
      const prisma1 = getPrisma();
      // Webhook path with Redis unavailable: probot app instance.
      const offlineProbot = new Probot({
        appId: 123,
        privateKey,
        Octokit: ProbotOctokit.defaults((instanceOptions: any) => ({
          ...instanceOptions,
          retry: { enabled: false },
          throttle: { enabled: false },
        })),
      });
      offlineProbot.load(myProbotApp);
      await receiveDelivery(
        offlineProbot,
        "pull_request",
        "opened",
        pullRequestPayload("opened", { headSha: "abab7777abab7777abab7777abab7777abab7777" }),
        "delivery-outbox-1",
      );
      await offlineProbot.teardown?.();

      const review = await prisma1.review.findFirstOrThrow();
      expect(review.state).toBe("queued");
      const job = await prisma1.reviewJob.findFirstOrThrow({ where: { reviewId: review.id } });
      expect(job.status).toBe("pending_outbox");
      const event = await prisma1.outboxEvent.findFirstOrThrow({ where: { reviewJobId: job.id } });
      expect(event.status).toBe("pending");

      // Restart Redis, then recover.
      await shell("docker start ticket01-redis");
      await waitRedisUp();
      // The queue connection gave up during the outage; recreate it.
      await ensureQueueReady();

      const summary = await recoverOutbox();
      expect(summary.scanned).toBeGreaterThanOrEqual(1);
      expect(summary.published).toBeGreaterThanOrEqual(1);

      const jobAfter = await prisma1.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(jobAfter.status).toBe("enqueued");
      const eventAfter = await prisma1.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(eventAfter.status).toBe("published");
    } finally {
      // Ensure Redis is back up even on failure.
      const redisUp = await checkRedis();
      if (redisUp.status !== "ok") {
        await shell("docker start ticket01-redis");
        await waitRedisUp();
      }
    }
  }, 60_000);
});

// Helpers ---------------------------------------------------------------------

async function shell(command: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("sh", ["-c", command], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command}: ${(stderr || stdout || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

async function waitRedisUp(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const check = await checkRedis();
    if (check.status === "ok") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Redis did not come back up in time");
}
