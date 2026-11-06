/**
 * OpenCode CLI agent runtime adapter (ARCHITECTURE.md §8.2–§8.4).
 *
 * Implements the `AgentRuntime` interface by driving the OpenCode CLI
 * (`opencode run --format json`; note: `--standalone` breaks custom
 * npm-package providers, see opencode-config.ts) as a child process:
 *
 * - One isolated session per review: the child gets its own
 *   XDG_CONFIG_HOME/XDG_DATA_HOME rooted in a session-owned temp directory
 *   holding a generated `opencode.json` (see `opencode-config.ts`).
 * - Process lifecycle without shell interpolation: argv array, no `shell`.
 * - Structured output capture: NDJSON events from `--format json` are parsed;
 *   the final assistant text is extracted and, for JSON tasks, parsed and
 *   validated.
 * - Error normalization: every failure surfaces as `AgentRuntimeError` with a
 *   stable code (§8.4) — no automatic retries, no model switching.
 * - No secrets in logs/output: the API key value is scrubbed from anything
 *   logged or attached to errors; the key is only passed by env-var reference.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  AgentRuntimeError,
  type AgentResult,
  type AgentRuntime,
  type AgentSession,
  type AgentSessionOptions,
  type AgentTask,
  type RuntimeHealth,
} from "./types.js";
import {
  buildChildEnv,
  buildSessionConfig,
  resolveModelId,
  type AgentRuntimeConfigSource,
} from "./opencode-config.js";

/** Minimal logger surface the adapter needs (compatible with the pino logger). */
export interface AgentRuntimeLogger {
  debug(msg: string, obj?: unknown): void;
  info(msg: string, obj?: unknown): void;
  warn(msg: string, obj?: unknown): void;
  error(msg: string, obj?: unknown): void;
}

export interface OpenCodeRuntimeOptions {
  /** Absolute path to the opencode binary. Defaults to PATH lookup. */
  binaryPath?: string;
  logger?: AgentRuntimeLogger;
  /** Default timeout per task when the session options do not set one. */
  defaultTimeoutMs?: number;
  /**
   * Spawn implementation (for tests). Must behave like `child_process.spawn`
   * and must never be invoked with a shell.
   */
  spawnImpl?: typeof spawn;
  /** fs.rm override for tests. */
  rmImpl?: (dir: string, options: { recursive: true; force: true }) => Promise<void>;
  /**
   * Workspace snapshot override for tests: returns `git status --porcelain`
   * output for the workspace, or undefined when git is unavailable (the
   * integrity guard is then skipped).
   */
  gitStatusImpl?: (workspacePath: string) => Promise<string | undefined>;
}

/**
 * Known limitation (verified against OpenCode v2.1.2): the CLI does NOT
 * enforce the `permission` configuration in `opencode run` mode — deny rules
 * are accepted but write/edit tool calls still succeed. Until ticket 11 adds
 * kernel-level sandboxing, the runtime compensates at the application layer
 * with a post-run workspace integrity check: the workspace is snapshotted
 * with `git status --porcelain` before and after every execution and any
 * modification fails the task with `workspace_modified`.
 */
const KNOWN_PERMISSION_GAP =
  "opencode CLI does not enforce permission rules in run mode " +
  "(verified v2.1.2); post-run workspace integrity checks compensate until " +
  "ticket 11 sandboxing";

/** NDJSON event emitted by `opencode run --format json`. */
interface OpenCodeEvent {
  type: string;
  part?: {
    type?: string;
    text?: string;
    tokens?: {
      usage?: { input?: number; output?: number; reasoning?: number; cache?: unknown };
    };
  };
  message?: string;
}

/** How long to wait after SIGTERM before escalating to SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** Max characters kept from any runtime detail attached to errors. */
const MAX_DETAIL_LENGTH = 500;
/** Upper bound on captured child output (both streams), bytes. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export class OpenCodeAgentRuntime implements AgentRuntime {
  private readonly binaryPath: string;
  private readonly logger?: AgentRuntimeLogger;
  private readonly defaultTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly rmImpl: (dir: string, options: { recursive: true; force: true }) => Promise<void>;
  private readonly gitStatusImpl: (workspacePath: string) => Promise<string | undefined>;
  private warnedPermissionGap = false;
  private readonly config: AgentRuntimeConfigSource;
  /** session id -> in-flight child, so terminate() can kill running tasks. */
  private readonly running = new Map<string, Set<import("node:child_process").ChildProcess>>();
  private readonly terminated = new Set<string>();

  constructor(config: AgentRuntimeConfigSource, options: OpenCodeRuntimeOptions = {}) {
    if (config.agent.runtime.type !== "opencode-cli") {
      throw new AgentRuntimeError(
        "config",
        `unsupported agent runtime type "${config.agent.runtime.type}"`,
      );
    }
    this.config = config;
    this.binaryPath =
      options.binaryPath ?? process.env.OPENCODE_BINARY_PATH ?? "/opt/homebrew/bin/opencode";
    this.logger = options.logger;
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? config.agent.runtime.timeoutMs;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.rmImpl = options.rmImpl ?? rm;
    this.gitStatusImpl = options.gitStatusImpl ?? defaultGitStatus;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async startSession(options: AgentSessionOptions): Promise<AgentSession> {
    const id = `sess_${randomUUID()}`;
    // Session-owned directory: never inside the review workspace, never
    // writable by the agent (deny-by-default permissions cover that too).
    const sessionDir = path.join(
      os.tmpdir(),
      "opencode-review-sessions",
      `${options.reviewId}-${sessionIdKey(id)}`,
    );
    const configDir = path.join(sessionDir, "config");
    const dataDir = path.join(sessionDir, "data");
    await mkdir(configDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });

    const modelId = resolveModelId(this.config, process.env);
    const maxOutputTokens = options.maxOutputTokens ?? this.config.agent.context.maxOutputTokens;
    const sessionConfig = buildSessionConfig({
      sessionDir,
      workspacePath: options.workspacePath,
      config: this.config,
      modelId,
      maxOutputTokens,
    });
    // The config file contains no secret material — the API key is a
    // `{env:VAR}` reference resolved from the child environment.
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify(sessionConfig, null, 2),
      "utf8",
    );

    this.logger?.debug("agent session created", {
      sessionId: id,
      reviewId: options.reviewId,
      modelId,
      sessionDir,
    });

    return {
      id,
      reviewId: options.reviewId,
      workspacePath: options.workspacePath,
      createdAt: new Date().toISOString(),
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
    };
  }

  async execute(session: AgentSession, task: AgentTask): Promise<AgentResult> {
    if (this.terminated.has(session.id)) {
      throw new AgentRuntimeError("config", "session is terminated", { sessionId: session.id });
    }
    const startedAt = Date.now();
    const prompt = buildPrompt(task);
    const args = ["run", "--format", "json", prompt];
    const env = buildChildEnv(this.config, process.env);
    // Isolation: fresh per-session config/data; binary from PATH; no git
    // credential helpers, no GITHUB_TOKEN, nothing else from the host env.
    env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "opencode-review-sessions", sessionDirKey(session), "config");
    env.XDG_DATA_HOME = path.join(os.tmpdir(), "opencode-review-sessions", sessionDirKey(session), "data");

    this.logger?.debug("agent execute start", {
      sessionId: session.id,
      reviewId: session.reviewId,
      argv: ["opencode", ...args.slice(0, args.length - 1), "<prompt>"],
    });
    if (!this.warnedPermissionGap) {
      this.warnedPermissionGap = true;
      this.logger?.warn(KNOWN_PERMISSION_GAP, { sessionId: session.id });
    }

    // Baseline snapshot for the post-run integrity guard (see
    // KNOWN_PERMISSION_GAP): the agent must never modify the workspace.
    const baseline = await this.gitStatusImpl(session.workspacePath);

    let child: import("node:child_process").ChildProcess;
    try {
      // argv array only — never a shell (§8.2 lifecycle requirements).
      child = this.spawnImpl(this.binaryPath, args, {
        cwd: session.workspacePath,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      throw new AgentRuntimeError("spawn", "failed to launch opencode runtime", {
        sessionId: session.id,
        cause,
      });
    }

    let running = this.running.get(session.id);
    if (!running) {
      running = new Set();
      this.running.set(session.id, running);
    }
    running.add(child);

    try {
      const outcome = await this.collect(child, session.id, session.timeoutMs);
      const result = this.interpret(outcome, session.id, task, Date.now() - startedAt);
      await this.assertWorkspaceUnchanged(session, baseline);
      return result;
    } finally {
      running.delete(child);
      if (running.size === 0) this.running.delete(session.id);
    }
  }

  async terminate(session: AgentSession): Promise<void> {
    this.terminated.add(session.id);
    const running = this.running.get(session.id);
    if (running) {
      for (const child of running) {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGTERM");
        }
      }
      running.clear();
    }
    this.running.delete(session.id);
    await this.rmImpl(sessionRoot(session), { recursive: true, force: true });
    this.logger?.debug("agent session terminated", { sessionId: session.id });
  }

  // -------------------------------------------------------------------------
  // Workspace integrity (application-layer compensation for the CLI's
  // unenforced permission rules — see KNOWN_PERMISSION_GAP)
  // -------------------------------------------------------------------------

  private async assertWorkspaceUnchanged(
    session: AgentSession,
    baseline: string | undefined,
  ): Promise<void> {
    if (baseline === undefined) return; // git unavailable — guard skipped
    const after = await this.gitStatusImpl(session.workspacePath);
    if (after === undefined || after === baseline) return;
    throw new AgentRuntimeError(
      "workspace_modified",
      "agent modified the review workspace; permission enforcement gap detected",
      {
        sessionId: session.id,
        detail: truncate(scrub(after, this.config)),
      },
    );
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async healthCheck(): Promise<RuntimeHealth> {
    const checkedAt = new Date().toISOString();
    return await new Promise<RuntimeHealth>((resolve) => {
      let settled = false;
      const done = (health: RuntimeHealth) => {
        if (!settled) {
          settled = true;
          resolve(health);
        }
      };
      let child: import("node:child_process").ChildProcess;
      try {
        child = this.spawnImpl(this.binaryPath, ["--version"], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        done({ healthy: false, detail: "runtime binary could not be launched", checkedAt });
        return;
      }
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < 1024) stdout += chunk.toString("utf8");
      });
      child.once("error", () =>
        done({ healthy: false, detail: "runtime binary unavailable", checkedAt }),
      );
      child.once("close", (code) => {
        if (code === 0) {
          const version = stdout.trim().split("\n")[0] ?? "";
          done({
            healthy: true,
            detail: `opencode-cli ${version || "unknown version"}`,
            checkedAt,
          });
        } else {
          done({ healthy: false, detail: `runtime exited with code ${code}`, checkedAt });
        }
      });
      // Bound the probe as well.
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
          done({ healthy: false, detail: "runtime probe timed out", checkedAt });
        }
      }, 10_000).unref();
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private collect(
    child: import("node:child_process").ChildProcess,
    sessionId: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;

      const timer = setTimeout(() => {
        // Escalating kill: TERM first, KILL after the grace period.
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled && child.exitCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS).unref();
      }, timeoutMs);
      timer.unref();

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        stderr += chunk.toString("utf8");
      });
      child.once("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          err.code === "ENOENT"
            ? new AgentRuntimeError("spawn", "opencode binary not found", { sessionId, cause: err })
            : new AgentRuntimeError("spawn", "failed to launch opencode runtime", {
                sessionId,
                cause: err,
              }),
        );
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal || (code !== null && code !== 0)) {
          reject(
            new AgentRuntimeError(
              "crash",
              signal ? `agent runtime killed by signal ${signal}` : `agent runtime exited with code ${code}`,
              { sessionId, detail: truncate(scrub(stderr || stdout, this.config)) },
            ),
          );
          return;
        }
        resolve({ stdout, stderr, exitCode: code, signal });
        if (truncated) {
          this.logger?.warn("agent output truncated", { sessionId });
        }
      });
    });
  }

  private interpret(
    outcome: { stdout: string; stderr: string },
    sessionId: string,
    task: AgentTask,
    durationMs: number,
  ): AgentResult {
    // 1. Parse the NDJSON event stream.
    const parsed = parseEvents(outcome.stdout);
    if (parsed.errors.length > 0) {
      // Malformed runtime output is a runtime failure, not a model failure.
      throw new AgentRuntimeError("invalid_output", "agent runtime emitted unparseable events", {
        sessionId,
        detail: truncate(scrub(parsed.errors[0], this.config)),
      });
    }

    // 2. Runtime-level error events (e.g. provider auth failures come back as
    //    `type:"error"` events with exit code 0 — they must not pass silently).
    if (parsed.errorMessages.length > 0) {
      const message = parsed.errorMessages[0];
      const code = classifyErrorEvent(message);
      throw new AgentRuntimeError(code, describeError(code), {
        sessionId,
        detail: truncate(scrub(message, this.config)),
      });
    }

    const text = parsed.text.trim();
    if (!text) {
      throw new AgentRuntimeError("invalid_output", "agent produced no output", { sessionId });
    }

    const result: AgentResult = {
      sessionId,
      text,
      usage: parsed.usage,
      durationMs,
    };

    if (task.output === "json") {
      const extracted = extractJson(text);
      if (extracted === undefined) {
        throw new AgentRuntimeError(
          "invalid_output",
          "agent output did not contain a JSON object",
          { sessionId, detail: truncate(scrub(text, this.config)) },
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(extracted);
      } catch {
        throw new AgentRuntimeError("invalid_output", "agent JSON output failed to parse", {
          sessionId,
          detail: truncate(scrub(extracted, this.config)),
        });
      }
      if (task.validate) {
        const verdict = task.validate(value);
        if (!verdict.ok) {
          throw new AgentRuntimeError("invalid_output", "agent output failed validation", {
            sessionId,
            detail: truncate(verdict.error, MAX_DETAIL_LENGTH),
          });
        }
        result.value = verdict.value;
      }
      result.json = value;
    }

    this.logger?.info("agent execute finished", {
      sessionId,
      durationMs,
      usage: result.usage,
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildPrompt(task: AgentTask): string {
  if (task.output === "text") return task.instruction;
  // For JSON tasks the format requirement travels in the prompt, but the
  // security configuration itself never does (§10.1).
  return `${task.instruction}\n\nRespond with exactly one JSON object and nothing else — no prose, no markdown fences.`;
}

// ---------------------------------------------------------------------------
// NDJSON event parsing
// ---------------------------------------------------------------------------

function parseEvents(stdout: string): {
  text: string;
  usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | undefined;
  errorMessages: string[];
  errors: string[];
} {
  const textParts: string[] = [];
  let usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | undefined;
  const errorMessages: string[] = [];
  const errors: string[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: OpenCodeEvent;
    try {
      event = JSON.parse(trimmed) as OpenCodeEvent;
    } catch {
      errors.push(trimmed);
      continue;
    }
    switch (event.type) {
      case "text":
        if (typeof event.part?.text === "string") textParts.push(event.part.text);
        break;
      case "step_finish": {
        const u = event.part?.tokens?.usage;
        if (u) {
          // The final text step may finish without usage; keep the last
          // step_finish that actually carries token counts.
          usage = {
            inputTokens: u.input,
            outputTokens: u.output,
            reasoningTokens: u.reasoning,
          };
        }
        break;
      }
      case "error":
        if (typeof event.message === "string") errorMessages.push(event.message);
        break;
      default:
        break; // step_start, tool, … are ignored
    }
  }
  return { text: textParts.join(""), usage, errorMessages, errors };
}

/** Map a runtime `type:"error"` event onto a normalized AgentErrorCode. */
function classifyErrorEvent(message: string): "provider_unavailable" | "permission_denied" | "invalid_output" {
  const lower = message.toLowerCase();
  if (lower.includes("permission")) return "permission_denied";
  if (
    lower.includes("provider") ||
    lower.includes("auth") ||
    lower.includes("api key") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("429") ||
    lower.includes("5/") ||
    lower.includes("unavailable") ||
    lower.includes("timeout")
  ) {
    return "provider_unavailable";
  }
  return "invalid_output";
}

function describeError(code: "provider_unavailable" | "permission_denied" | "invalid_output"): string {
  switch (code) {
    case "provider_unavailable":
      return "model provider could not serve the agent request";
    case "permission_denied":
      return "agent was blocked by the tool permission policy";
    case "invalid_output":
      return "agent reported an error";
  }
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Extract the first balanced JSON object from assistant text. Tolerates
 * markdown fences and surrounding prose; reasoning models sometimes add
 * commentary around the payload.
 */
export function extractJson(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const inner = fence[1].trim();
    if (inner.startsWith("{")) return inner;
  }
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Secret scrubbing & truncation
// ---------------------------------------------------------------------------

/**
 * Remove the provider API key value and anything that looks like an
 * authorization header from runtime output before it is logged or attached
 * to an error (§10.6).
 */
function scrub(text: string, config: AgentRuntimeConfigSource): string {
  let out = text;
  const key = process.env[config.provider.apiKeyEnv];
  if (key) out = out.split(key).join("[redacted]");
  out = out.replace(/(authorization|api[-_]?key|x-api-key)["'=:\s]+\S+/gi, '$1[redacted]');
  return out;
}

function truncate(text: string, max = MAX_DETAIL_LENGTH): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The session directory name is derived from the review id, but startSession
 * knows the full name; for execute/terminate we recover it deterministically.
 * Sessions always live under the fixed root, keyed by review id prefix.
 */
function sessionDirKey(session: AgentSession): string {
  return `${session.reviewId}-${sessionIdKey(session.id)}`;
}

/** The short discriminator embedded in every session id (`sess_<8 hex>`). */
function sessionIdKey(id: string): string {
  return id.replace(/^sess_/, "").slice(0, 8);
}

function sessionRoot(session: AgentSession): string {
  return path.join(os.tmpdir(), "opencode-review-sessions", sessionDirKey(session));
}

/**
 * Snapshot the workspace with `git status --porcelain` (deterministic: paths
 * sorted). Returns undefined when git is missing or the directory is not a
 * work tree — the integrity guard is best-effort until ticket 11 sandboxing.
 * Runs git with the sanitized child env (no GitHub credentials).
 */
async function defaultGitStatus(workspacePath: string): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    let out = "";
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn("git", ["status", "--porcelain"], {
        cwd: workspacePath,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        resolve(code === 0 ? out.split("\n").filter(Boolean).sort().join("\n") : undefined);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve(undefined);
      }
    }, 5_000).unref();
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the configured agent runtime behind the `AgentRuntime` abstraction.
 * Review logic (ticket 07) imports this from `../agent/index.js` — never the
 * concrete adapter class — so the runtime stays swappable.
 */
export function createAgentRuntime(
  config: AgentRuntimeConfigSource,
  options: OpenCodeRuntimeOptions = {},
): AgentRuntime {
  return new OpenCodeAgentRuntime(config, options);
}
