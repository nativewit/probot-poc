import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Env } from "../config/env.js";
import {
  DEFAULT_CONFIG_PATH,
  LAST_KNOWN_GOOD_SUFFIX,
  ConfigValidationError,
  checkForEmbeddedSecrets,
  createConfigurationSnapshot,
  loadReviewConfig,
  redactConfiguration,
  resolveEnvReferences,
  restoreLastKnownGood,
  updateReviewConfig,
  validateRawConfig,
} from "../config/review-loader.js";
import { getReviewStatus } from "../ingestion/orchestrator.js";
import {
  buildAuthorizeUrl,
  exchangeOAuthCode,
  fetchGithubUser,
  fetchOrgMembership,
  GithubOauthError,
} from "./github-client.js";
import {
  CSRF_HEADER,
  buildClearCookieHeader,
  buildSetCookieHeader,
  createSession,
  destroySession,
  getSessionFromCookie,
  readSessionCookie,
  verifyCsrfToken,
  type AdminSession,
} from "./session.js";
import { checkRateLimit, clientIpOf } from "./rate-limit.js";
import { recordAuditLog, type AuditAction } from "./audit.js";

/**
 * Admin API (ticket 10, §14.2 + §15): GitHub OAuth authentication, membership
 * verification, admin role policy (separate from membership), session/CSRF
 * handling, configuration management endpoints, review status endpoints and
 * audit logging.
 *
 * The GitHub App installation identity is never used here: admin identity is
 * the OAuth user identity only.
 */

export interface AdminApiDeps {
  env: Env;
  prisma: PrismaClient;
  logger: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
  configPath?: string;
  now?: () => number;
}

export function isAdminConfigured(env: Env): boolean {
  return Boolean(
    env.ADMIN_OAUTH_CLIENT_ID &&
      env.ADMIN_OAUTH_CLIENT_SECRET &&
      env.SESSION_SECRET &&
      env.ADMIN_GITHUB_ORG,
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > maxBytes) {
      throw new BodyTooLargeError();
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidBodyError();
  }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
  }
}
export class InvalidBodyError extends Error {
  constructor() {
    super("request body must be JSON");
  }
}

// ---------------------------------------------------------------------------
// OAuth state store (CSRF protection for the authorize redirect itself)
// ---------------------------------------------------------------------------

interface PendingState {
  expiresAt: number;
}

const oauthStates = new Map<string, PendingState>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function clearOauthStates(): void {
  oauthStates.clear();
}

function createOauthState(now: number): string {
  if (oauthStates.size > 1000) {
    for (const [key, pending] of oauthStates) {
      if (pending.expiresAt <= now) oauthStates.delete(key);
    }
  }
  const state = randomBytes(24).toString("base64url");
  oauthStates.set(state, { expiresAt: now + STATE_TTL_MS });
  return state;
}

/** Consume a state value: valid only once, only within its TTL. */
function consumeOauthState(state: string | null, now: number): boolean {
  if (!state) return false;
  const pending = oauthStates.get(state);
  oauthStates.delete(state); // single use
  return Boolean(pending && pending.expiresAt > now);
}

// ---------------------------------------------------------------------------
// Admin role policy (§14.2: separate from membership)
// ---------------------------------------------------------------------------

function parseLoginAllowlist(env: Env): string[] {
  return env.ADMIN_GITHUB_LOGINS.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseAdminRoles(env: Env): string[] {
  return env.ADMIN_ORG_ADMIN_ROLES.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

export interface AdminAuthorization {
  allowed: boolean;
  rolePolicy: "allowlist" | "org-role" | null;
  reason: string;
}

/**
 * Decide admin authorization for an authenticated member. Membership in
 * ADMIN_GITHUB_ORG is the gate; this policy decides WHO among members is an
 * administrator: a configured login allowlist wins, otherwise the
 * organization role must be one of ADMIN_ORG_ADMIN_ROLES.
 */
export function authorizeAdmin(
  env: Env,
  user: { login: string },
  membership: { role: "admin" | "member"; state: "active" | "pending" } | null,
): AdminAuthorization {
  if (!membership) {
    return { allowed: false, rolePolicy: null, reason: "not an organization member" };
  }
  if (membership.state === "pending") {
    return { allowed: false, rolePolicy: null, reason: "organization membership is pending" };
  }
  const allowlist = parseLoginAllowlist(env);
  if (allowlist.length > 0) {
    const allowed = allowlist.includes(user.login);
    return { allowed, rolePolicy: "allowlist", reason: allowed ? "allowlisted administrator" : "not on the admin allowlist" };
  }
  const roles = parseAdminRoles(env);
  const allowed = roles.includes(membership.role);
  return {
    allowed,
    rolePolicy: "org-role",
    reason: allowed ? `organization role '${membership.role}' grants admin` : `organization role '${membership.role}' does not grant admin`,
  };
}

// ---------------------------------------------------------------------------
// Request pipeline
// ---------------------------------------------------------------------------

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface AdminRequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  deps: AdminApiDeps;
  env: Env;
  ip: string;
}

export function createAdminApi(deps: AdminApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const env = deps.env;
  // Configuration files reference arbitrary env vars (e.g. ${MODEL_BASE_URL});
  // resolution uses the real process environment merged with the validated
  // admin env. Secret VALUES never enter config responses (loader redacts).
  const processEnv = {
    ...process.env,
    ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
  } as unknown as NodeJS.ProcessEnv;
  const configPath = deps.configPath ?? DEFAULT_CONFIG_PATH;
  const now = deps.now ?? Date.now;
  const configured = isAdminConfigured(env);
  if (!configured) {
    deps.logger.warn(
      {
        missing: [
          !env.ADMIN_OAUTH_CLIENT_ID && "ADMIN_OAUTH_CLIENT_ID",
          !env.ADMIN_OAUTH_CLIENT_SECRET && "ADMIN_OAUTH_CLIENT_SECRET",
          !env.SESSION_SECRET && "SESSION_SECRET",
          !env.ADMIN_GITHUB_ORG && "ADMIN_GITHUB_ORG",
        ].filter(Boolean),
      },
      "Admin API not configured; /api/admin/* returns 503",
    );
  }

  return async function handleAdminRequest(req, res): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!url.pathname.startsWith("/api/admin")) {
      return false;
    }
    const ctx: AdminRequestContext = { req, res, url, deps, env, ip: clientIpOf(req as never) };

    // Rate limiting applies to every admin endpoint (§14.2), including the
    // OAuth endpoints so they cannot be used to brute-force accounts.
    const limit = checkRateLimit(`admin:${ctx.ip}`, { limitPerMinute: env.ADMIN_RATE_LIMIT_PER_MINUTE, now });
    res.setHeader("X-RateLimit-Limit", String(env.ADMIN_RATE_LIMIT_PER_MINUTE));
    res.setHeader("X-RateLimit-Remaining", String(limit.remaining));
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      sendJson(res, 429, { error: "rate limit exceeded", retryAfterSeconds: limit.retryAfterSeconds });
      return true;
    }

    if (!configured) {
      sendJson(res, 503, { error: "admin API is not configured" });
      return true;
    }

    try {
      await route(ctx);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
        return true;
      }
      if (error instanceof InvalidBodyError) {
        sendJson(res, 400, { error: "request body must be JSON" });
        return true;
      }
      if (error instanceof GithubOauthError) {
        // GitHub's own error descriptions are safe to surface; they never
        // include the client secret.
        sendJson(res, 502, { error: "github oauth failure", code: error.code, description: error.message });
        return true;
      }
      if (error instanceof ConfigValidationError) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      deps.logger.error({ err: (error as Error).stack ?? String(error) }, "Admin API request failed");
      sendJson(res, 500, { error: "internal admin error" });
    }
    return true;
  };

  // -------------------------------------------------------------------------

  async function audit(actor: string, action: AuditAction, resource: string, metadata?: Record<string, unknown>): Promise<void> {
    await recordAuditLog(deps.prisma, { actor, action, resource, metadata }, deps.logger);
  }

  async function route(ctx: AdminRequestContext): Promise<void> {
    const { req, res, url } = ctx;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // --- Authentication endpoints (no session required) --------------------

    if (req.method === "GET" && path === "/api/admin/auth/github/login") {
      const state = createOauthState(now());
      const authorizeUrl = buildAuthorizeUrl(env, state);
      res.statusCode = 302;
      res.setHeader("Location", authorizeUrl);
      res.end();
      return;
    }

    if (req.method === "GET" && path === "/api/admin/auth/github/callback") {
      await handleOAuthCallback(ctx);
      return;
    }

    // --- Everything below requires a session -------------------------------

    const session = getSessionFromCookie(readSessionCookie(req.headers.cookie), env, now());

    if (req.method === "POST" && path === "/api/admin/auth/logout") {
      if (!session) {
        sendJson(res, 401, { error: "authentication required" });
        return;
      }
      if (!verifyCsrfToken(session, headerValue(req.headers[CSRF_HEADER]))) {
        sendJson(res, 403, { error: "csrf validation failed" });
        return;
      }
      destroySession(session.id);
      await audit(session.login, "admin.logout", "admin_session", {});
      sendJson(res, 200, { ok: true }, { "Set-Cookie": buildClearCookieHeader(env) });
      return;
    }

    if (req.method === "GET" && path === "/api/admin/session") {
      if (!session) {
        sendJson(res, 401, { error: "authentication required" });
        return;
      }
      sendJson(res, 200, {
        authenticated: true,
        user: { login: session.login, id: session.githubUserId },
        rolePolicy: session.rolePolicy,
        csrfToken: session.csrfToken,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
      return;
    }

    if (!session) {
      sendJson(res, 401, { error: "authentication required" });
      return;
    }

    // --- CSRF protection on every unsafe method (§14.2) --------------------

    if (UNSAFE_METHODS.has(req.method ?? "") && !verifyCsrfToken(session, headerValue(req.headers[CSRF_HEADER]))) {
      sendJson(res, 403, { error: "csrf validation failed" });
      return;
    }

    // --- Configuration management (§11.5, §15) -----------------------------

    if (req.method === "GET" && path === "/api/admin/config") {
      await handleReadConfig(ctx);
      return;
    }

    if (req.method === "PUT" && path === "/api/admin/config") {
      await handleUpdateConfig(ctx, session);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/validate") {
      await handleValidateConfig(ctx);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/dry-run") {
      await handleDryRunConfig(ctx);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/reload") {
      await handleReloadConfig(ctx, session);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/rollback") {
      await handleRollbackConfig(ctx, session);
      return;
    }

    // --- Review status (§15) -----------------------------------------------

    if (req.method === "GET" && path === "/api/admin/reviews") {
      await handleListReviews(ctx);
      return;
    }

    const reviewMatch = /^\/api\/admin\/reviews\/([A-Za-z0-9_-]+)$/.exec(path);
    if (req.method === "GET" && reviewMatch) {
      await handleReviewDetail(res, reviewMatch[1]!);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  // -------------------------------------------------------------------------
  // OAuth callback
  // -------------------------------------------------------------------------

  async function handleOAuthCallback(ctx: AdminRequestContext): Promise<void> {
    const { res, url } = ctx;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!consumeOauthState(state, now())) {
      await audit("anonymous", "admin.login_denied", "admin_session", { reason: "invalid or expired oauth state" });
      sendJson(res, 400, { error: "invalid or expired oauth state" });
      return;
    }
    if (!code) {
      sendJson(res, 400, { error: "missing oauth code" });
      return;
    }

    const accessToken = await exchangeOAuthCode(env, code);
    const user = await fetchGithubUser(accessToken);
    const membership = await fetchOrgMembership(env.ADMIN_GITHUB_ORG!, user.login, accessToken);
    const decision = authorizeAdmin(env, user, membership);

    if (!decision.allowed) {
      await audit(user.login, "admin.login_denied", "admin_session", { reason: decision.reason, rolePolicy: decision.rolePolicy });
      sendJson(res, 403, { error: "admin access denied", reason: decision.reason });
      return;
    }

    const newSession = createSession(user, decision.rolePolicy === "allowlist" ? "allowlist" : "org-role", { env, now });
    await audit(user.login, "admin.login", "admin_session", { rolePolicy: newSession.rolePolicy });
    deps.logger.info({ login: user.login, rolePolicy: newSession.rolePolicy }, "Admin logged in");
    sendJson(
      res,
      200,
      { authenticated: true, user: { login: user.login, id: user.id }, rolePolicy: newSession.rolePolicy, csrfToken: newSession.csrfToken },
      { "Set-Cookie": buildSetCookieHeader(newSession, env) },
    );
  }

  // -------------------------------------------------------------------------
  // Configuration endpoints
  // -------------------------------------------------------------------------

  async function handleReadConfig(ctx: AdminRequestContext): Promise<void> {
    const loaded = loadReviewConfig(configPath, { env: processEnv, allowLastKnownGoodFallback: true });
    sendJson(ctx.res, 200, {
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
      schemaVersion: loaded.snapshot.schemaVersion,
      configuration: redactConfiguration(loaded.config),
    });
  }

  async function handleValidateConfig(ctx: AdminRequestContext): Promise<void> {
    const candidate = await readJsonBody(ctx.req);
    try {
      checkForEmbeddedSecrets(candidate);
      const resolved = resolveEnvReferences(candidate, processEnv);
      const config = validateRawConfig(resolved);
      sendJson(ctx.res, 200, {
        valid: true,
        hash: createConfigurationSnapshot(config).hash,
        configuration: redactConfiguration(config),
      });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        // Zod/embedded-secret messages name property paths, never secret values.
        sendJson(ctx.res, 200, { valid: false, error: error.message });
        return;
      }
      throw error;
    }
  }

  async function handleDryRunConfig(ctx: AdminRequestContext): Promise<void> {
    const candidate = await readJsonBody(ctx.req);
    try {
      checkForEmbeddedSecrets(candidate);
      const resolved = resolveEnvReferences(candidate, processEnv);
      const config = validateRawConfig(resolved);
      const snapshot = createConfigurationSnapshot(config);
      sendJson(ctx.res, 200, {
        valid: true,
        hash: snapshot.hash,
        schemaVersion: snapshot.schemaVersion,
        configuration: redactConfiguration(config),
        applied: false,
      });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        sendJson(ctx.res, 200, { valid: false, applied: false, error: error.message });
        return;
      }
      throw error;
    }
  }

  async function handleUpdateConfig(ctx: AdminRequestContext, session: AdminSession): Promise<void> {
    const candidate = await readJsonBody(ctx.req);
    try {
      const result = updateReviewConfig(configPath, candidate, { env: processEnv });
      const resource = "configuration";
      await audit(session.login, "config.update", resource, {
        previousHash: result.previous.snapshot.hash,
        nextHash: result.next.snapshot.hash,
        nextCapturedAt: result.next.snapshot.capturedAt,
      });
      sendJson(ctx.res, 200, {
        updated: true,
        previousHash: result.previous.snapshot.hash,
        hash: result.next.snapshot.hash,
        configuration: redactConfiguration(result.next.config),
      });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        // Atomic guarantee: updateReviewConfig validated BEFORE any write, so
        // review.json and the last-known-good snapshot are untouched here.
        await audit(session.login, "config.update_rejected", "configuration", { reason: "validation failed" });
        sendJson(ctx.res, 400, { updated: false, error: error.message });
        return;
      }
      throw error;
    }
  }

  async function handleReloadConfig(ctx: AdminRequestContext, session: AdminSession): Promise<void> {
    // §11.5: re-read from disk, validate before activation, keep the previous
    // configuration available (the loader's LKG protection covers the case of
    // a file that no longer validates: it reports fromLastKnownGood=true).
    const loaded = loadReviewConfig(configPath, { env: processEnv, allowLastKnownGoodFallback: true, updateLastKnownGood: true });
    await audit(session.login, "config.reload", "configuration", {
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
    });
    sendJson(ctx.res, 200, {
      reloaded: true,
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
      configuration: redactConfiguration(loaded.config),
    });
  }

  async function handleRollbackConfig(ctx: AdminRequestContext, session: AdminSession): Promise<void> {
    const lkgPath = configPath + LAST_KNOWN_GOOD_SUFFIX;
    try {
      JSON.parse(readFileSync(lkgPath, "utf8")); // existence probe only
    } catch {
      await audit(session.login, "config.rollback_failed", "configuration", { reason: "no last-known-good snapshot" });
      sendJson(ctx.res, 409, { error: "no last-known-good configuration available" });
      return;
    }
    try {
      // Restores from the validated snapshot even when the active file is
      // broken (that is the whole point of rollback), so we must not use
      // updateReviewConfig here: it refuses to write over an invalid file.
      const restored = restoreLastKnownGood(configPath);
      await audit(session.login, "config.rollback", "configuration", {
        restoredHash: restored.snapshot.hash,
      });
      sendJson(ctx.res, 200, {
        rolledBack: true,
        hash: restored.snapshot.hash,
        configuration: redactConfiguration(restored.config),
      });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        await audit(session.login, "config.rollback_failed", "configuration", { reason: "last-known-good snapshot failed validation" });
        sendJson(ctx.res, 409, { error: "last-known-good snapshot failed validation" });
        return;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Review status endpoints
  // -------------------------------------------------------------------------

  async function handleListReviews(ctx: AdminRequestContext): Promise<void> {
    const state = ctx.url.searchParams.get("state");
    const limitRaw = Number(ctx.url.searchParams.get("limit") ?? "20");
    const offsetRaw = Number(ctx.url.searchParams.get("offset") ?? "0");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 20;
    const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;

    const where = state ? { state: state as never } : {};
    const [rows, total] = await Promise.all([
      deps.prisma.review.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
        include: { pullRequest: { include: { repository: true } } },
      }),
      deps.prisma.review.count({ where }),
    ]);

    sendJson(ctx.res, 200, {
      total,
      limit,
      offset,
      reviews: rows.map((row) => ({
        id: row.id,
        state: row.state,
        repository: row.pullRequest.repository.fullName,
        pullRequestNumber: row.pullRequestNumber,
        pullRequestId: row.pullRequestId,
        headSha: row.headSha,
        reviewMode: row.reviewMode,
        trigger: row.trigger,
        provider: row.provider,
        model: row.model,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        errorCode: row.errorCode,
        createdAt: row.createdAt,
      })),
    });
  }

  async function handleReviewDetail(res: ServerResponse, reviewId: string): Promise<void> {
    const report = await getReviewStatus(reviewId);
    if (!report) {
      sendJson(res, 404, { error: "review not found" });
      return;
    }
    sendJson(res, 200, report);
  }
}
