import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  buildChildEnv,
  buildPermissionRules,
  buildSessionConfig,
  resolveModelId,
  type AgentRuntimeConfigSource,
} from "../src/agent/opencode-config.js";
import {
  extractJson,
  OpenCodeAgentRuntime,
  type OpenCodeRuntimeOptions,
} from "../src/agent/opencode-runtime.js";
import { AgentRuntimeError, type AgentSession } from "../src/agent/types.js";

// ---------------------------------------------------------------------------
// Test configuration fixture (mirrors the parsed review config shape)
// ---------------------------------------------------------------------------

const baseConfig: AgentRuntimeConfigSource = {
  provider: {
    type: "openai-compatible",
    baseURL: "https://llm.example.test/compat",
    apiKeyEnv: "MODEL_API_KEY",
    model: "workers-ai/@cf/zai-org/glm-4.7-flash",
    temperature: 0.1,
    maxOutputTokens: 8192,
    timeoutMs: 120_000,
  },
  agent: {
    runtime: { type: "opencode-cli", sessionStrategy: "per-review", timeoutMs: 900_000 },
    context: {
      adaptive: true,
      maxFiles: 100,
      maxRetrievalCalls: 40,
      maxInputTokens: 60_000,
      maxOutputTokens: 8192,
    },
    tools: {
      enabled: ["read_file", "list_files", "search_code"],
      permissionPolicy: "allowlist",
    },
  },
};

// ---------------------------------------------------------------------------
// Fake child process (spawn is mocked; no real process is launched here)
// ---------------------------------------------------------------------------

type SpawnArgs = [string, readonly string[], { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean }];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  signals: string[] = [];
  /** When set, kill() closes the process with this signal after a tick. */
  closeOnKill: string | null = "SIGTERM";

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (this.exitCode !== null) return true;
    if (this.closeOnKill) {
      const sig = this.closeOnKill;
      setTimeout(() => this.close(null, sig), 5);
    }
    return true;
  }

  /** Simulate the runtime closing normally. */
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code === null ? null : code;
    this.emit("close", code, signal);
  }

  writeOut(lines: string): void {
    this.stdout.emit("data", Buffer.from(lines, "utf8"));
  }
}

function makeSpawnStub(child: FakeChild) {
  const calls: SpawnArgs[] = [];
  const stub = ((_path: string, args: readonly string[], opts: SpawnArgs[2]) => {
    calls.push([_path, args, opts]);
    return child as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { stub, calls };
}

function makeRuntime(child: FakeChild, overrides: Partial<OpenCodeRuntimeOptions> = {}) {
  const { stub, calls } = makeSpawnStub(child);
  const rmImpl = vi.fn(async () => undefined);
  const runtime = new OpenCodeAgentRuntime(baseConfig, {
    spawnImpl: stub,
    rmImpl: rmImpl as unknown as OpenCodeRuntimeOptions["rmImpl"],
    // Default: git snapshot disabled — integrity tests override explicitly.
    gitStatusImpl: async () => undefined,
    ...overrides,
  });
  return { runtime, calls, rmImpl };
}

/** NDJSON helpers matching the probed real opencode `--format json` output. */
const stepStart = JSON.stringify({ type: "step_start", part: { type: "step_start" } });
const stepFinish = JSON.stringify({
  type: "step_finish",
  part: { type: "step_finish", tokens: { usage: { input: 120, output: 64, reasoning: 10, cache: {} } } },
});
const textEvent = (t: string) => JSON.stringify({ type: "text", part: { type: "text", text: t } });

async function startedSession(
  runtime: OpenCodeAgentRuntime,
): Promise<{ session: AgentSession; workspace: string }> {
  const workspace = "/tmp/review-workspace-fixture";
  const session = await runtime.startSession({ reviewId: "rev_test", workspacePath: workspace });
  return { session, workspace };
}

// ---------------------------------------------------------------------------
// Config building
// ---------------------------------------------------------------------------

describe("opencode config building", () => {
  it("deny-by-default: denies everything, allows only mapped tools, hardens secrets last", () => {
    const permission = buildPermissionRules(baseConfig);
    expect(permission["*"]).toBe("deny");
    expect(permission.external_directory).toBe("deny");
    expect(permission.glob).toBe("allow");
    expect(permission.grep).toBe("allow");
    const read = permission.read as Record<string, string>;
    expect(read["*"]).toBe("allow");
    // Secret files never reach the model even though reads are allowed.
    expect(read["*.env"]).toBe("deny");
    expect(read["*.env.*"]).toBe("deny");
    expect(read["*credential*"]).toBe("deny");
    // Shell, edits and web access are denied by the catch-all.
    expect(permission.bash).toBeUndefined();
    expect(permission.edit).toBeUndefined();
    expect(permission.webfetch).toBeUndefined();
  });

  it("permissionPolicy none yields deny-everything", () => {
    const permission = buildPermissionRules({
      ...baseConfig,
      agent: { ...baseConfig.agent, tools: { enabled: [], permissionPolicy: "none" } },
    });
    expect(permission["*"]).toBe("deny");
    expect(Object.keys(permission).filter((k) => k !== "*" && k !== "external_directory")).toHaveLength(0);
  });

  it("child env is an allowlist — GitHub and other host secrets are excluded", () => {
    const env = buildChildEnv(baseConfig, {
      PATH: "/usr/bin",
      HOME: "/home/u",
      GITHUB_TOKEN: "gh_secret",
      GITHUB_APP_ID: "12345",
      MODEL_API_KEY: "sk-supersecret",
      NPM_TOKEN: "npm-secret",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.MODEL_API_KEY).toBe("sk-supersecret");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
  });

  it("session config contains no secret material — key is an env reference", () => {
    const json = JSON.stringify(buildSessionConfig({
      sessionDir: "/tmp/s",
      workspacePath: "/tmp/w",
      config: baseConfig,
      modelId: "workers-ai/@cf/zai-org/glm-4.7-flash",
      maxOutputTokens: 4000,
    }));
    expect(json).not.toContain("sk-");
    expect(json).toContain("{env:MODEL_API_KEY}");
    expect(json).toContain("llm.example.test/compat");
  });

  it("resolveModelId prefers MODEL_NAME, falls back to provider.model", () => {
    expect(resolveModelId(baseConfig, { MODEL_NAME: "workers-ai/@cf/zai-org/glm-4.7-flash" })).toBe(
      "workers-ai/@cf/zai-org/glm-4.7-flash",
    );
    expect(resolveModelId(baseConfig, {})).toBe(baseConfig.provider.model);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  it("rejects unsupported runtime types", () => {
    expect(
      () =>
        new OpenCodeAgentRuntime({
          ...baseConfig,
          agent: { ...baseConfig.agent, runtime: { ...baseConfig.agent.runtime, type: "custom" } },
        }),
    ).toThrowError(AgentRuntimeError);
  });

  it("terminate kills in-flight execution and destroys the session directory", async () => {
    const child = new FakeChild();
    const { runtime, rmImpl } = makeRuntime(child);
    const { session } = await startedSession(runtime);

    const execute = runtime.execute(session, { instruction: "summarize", output: "text" });
    // Let the spawn happen, then terminate while the task is in flight.
    await new Promise((r) => setTimeout(r, 10));
    await runtime.terminate(session);
    expect(child.killed).toBe(true);
    expect(rmImpl).toHaveBeenCalledTimes(1);
    await expect(execute).rejects.toMatchObject({ code: "crash" });

    // After termination the session is dead: execute is rejected outright.
    await expect(
      runtime.execute(session, { instruction: "again", output: "text" }),
    ).rejects.toMatchObject({ code: "config" });
  });
});

// ---------------------------------------------------------------------------
// Task execution — success paths
// ---------------------------------------------------------------------------

describe("execute: successful tasks", () => {
  it("extracts final text and token usage from the NDJSON stream", async () => {
    const child = new FakeChild();
    const { runtime, calls } = makeRuntime(child);
    const { session, workspace } = await startedSession(runtime);

    const resultPromise = runtime.execute(session, { instruction: "summarize the diff", output: "text" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [path, args, opts] = calls[0];
    expect(path).toContain("opencode");
    // argv array — no shell interpolation ever.
    expect(opts.shell).toBe(false);
    expect(opts.cwd).toBe(workspace);
    expect(args.slice(0, 3)).toEqual(["run", "--format", "json"]);
    expect(args.join(" ")).toContain("summarize the diff");

    child.writeOut([stepStart, textEvent("The change looks fine."), stepFinish].join("\n") + "\n");
    child.close(0);

    const result = await resultPromise;
    expect(result.text).toBe("The change looks fine.");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 64, reasoningTokens: 10 });
    expect(result.sessionId).toBe(session.id);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("parses fenced JSON output and validates it", async () => {
    const child = new FakeChild();
    const { runtime, calls } = makeRuntime(child);
    const { session } = await startedSession(runtime);

    const resultPromise = runtime.execute(session, {
      instruction: "review",
      output: "json",
      validate: (v) =>
        typeof v === "object" && v !== null && "verdict" in v
          ? { ok: true, value: v }
          : { ok: false, error: "missing verdict" },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const payload = { verdict: "approve", findings: [] };
    child.writeOut(
      [
        stepStart,
        textEvent("```json\n" + JSON.stringify(payload) + "\n```"),
        stepFinish,
      ].join("\n") + "\n",
    );
    child.close(0);

    const result = await resultPromise;
    expect(result.json).toEqual(payload);
    expect(result.value).toEqual(payload);
    // The JSON format requirement must travel inside the prompt.
    expect(calls[0][1].join(" ")).toContain("JSON");
  });

  it("recovers JSON embedded in surrounding prose", () => {
    expect(extractJson('Sure! Here it is: {"a": {"b": 1}} hope that helps')).toBe('{"a": {"b": 1}}');
    expect(extractJson('{"x": "with \\" quote and } brace"}')).toBe('{"x": "with \\" quote and } brace"}');
    expect(extractJson("no json here")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task execution — failure paths (§8.4)
// ---------------------------------------------------------------------------

describe("execute: failure normalization", () => {
  it("timeout: kills the child and reports crash-on-signal", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const workspace = "/tmp/review-workspace-fixture";
    const session = await runtime.startSession({
      reviewId: "rev_timeout",
      workspacePath: workspace,
      timeoutMs: 80,
    });

    const resultPromise = runtime.execute(session, { instruction: "slow task", output: "text" });
    await new Promise((r) => setTimeout(r, 10));

    await expect(resultPromise).rejects.toMatchObject({
      code: "crash",
      message: expect.stringContaining("SIGTERM"),
    });
    expect(child.signals).toContain("SIGTERM");
  }, 10_000);

  it("explicit timeoutMs on the session overrides the runtime default", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const workspace = "/tmp/w";
    const session = await runtime.startSession({
      reviewId: "rev_t",
      workspacePath: workspace,
      timeoutMs: 123_456,
    });
    expect(session.timeoutMs).toBe(123_456);
  });

  it("crash: non-zero exit code is normalized", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const { session } = await startedSession(runtime);
    const resultPromise = runtime.execute(session, { instruction: "x", output: "text" });
    await vi.waitFor(() => expect(child.stdout.listenerCount("data")).toBeGreaterThan(0));
    child.stderr.emit("data", Buffer.from("segmentation fault (core dumped)"));
    child.close(1);
    await expect(resultPromise).rejects.toMatchObject({
      code: "crash",
      detail: expect.stringContaining("segmentation fault"),
    });
  });

  it("crash: spawn ENOENT is reported as a spawn error", async () => {
    const errorChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      killed: false,
      kill: () => true,
    }) as unknown as ChildProcess;
    const { stub } = makeSpawnStub(errorChild);
    const runtime = new OpenCodeAgentRuntime(baseConfig, { spawnImpl: stub });
    const { session } = await startedSession(runtime);
    const promise = runtime.execute(session, { instruction: "x", output: "text" });
    // The stub returns the child before spawn emits the async error.
    setTimeout(() => (errorChild as unknown as EventEmitter).emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" })), 5);
    await expect(promise).rejects.toMatchObject({ code: "spawn" });
  });

  it("provider unavailable: auth failure surfaces as an error event with exit code 0", async () => {
    const child = new FakeChild();
    const { runtime, calls } = makeRuntime(child);
    const { session } = await startedSession(runtime);
    const resultPromise = runtime.execute(session, { instruction: "x", output: "text" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.writeOut(
      JSON.stringify({
        type: "error",
        message: 'Provider "reviewer" failed: provider.auth (invalid API key for MODEL_API_KEY)',
      }) + "\n",
    );
    child.close(0); // opencode exits 0 even on provider errors — must not pass
    await expect(resultPromise).rejects.toMatchObject({
      code: "provider_unavailable",
      message: expect.stringContaining("provider"),
    });
  });

  it("permission denied: blocked tool call is normalized", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const { session } = await startedSession(runtime);
    const resultPromise = runtime.execute(session, { instruction: "x", output: "text" });
    await new Promise((r) => setTimeout(r, 10));
    child.writeOut(JSON.stringify({ type: "error", message: "Permission denied: bash by policy" }) + "\n");
    child.close(0);
    await expect(resultPromise).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("invalid output: empty text", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const { session } = await startedSession(runtime);
    const resultPromise = runtime.execute(session, { instruction: "x", output: "text" });
    await new Promise((r) => setTimeout(r, 10));
    child.writeOut(stepStart + "\n" + stepFinish + "\n");
    child.close(0);
    await expect(resultPromise).rejects.toMatchObject({
      code: "invalid_output",
      message: expect.stringContaining("no output"),
    });
  });

  it("invalid output: JSON task without a parseable object", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const { session } = await startedSession(runtime);
    const resultPromise = runtime.execute(session, { instruction: "x", output: "json" });
    await new Promise((r) => setTimeout(r, 10));
    child.writeOut([stepStart, textEvent("I could not produce JSON, sorry."), stepFinish].join("\n") + "\n");
    child.close(0);
    await expect(resultPromise).rejects.toMatchObject({
      code: "invalid_output",
      message: expect.stringContaining("JSON"),
    });
  });

  it("invalid output: validation failure carries the validator's reason", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const { session } = await startedSession(runtime);
    const resultPromise = runtime.execute(session, {
      instruction: "x",
      output: "json",
      validate: () => ({ ok: false, error: "verdict must be approve|request_changes" }),
    });
    await new Promise((r) => setTimeout(r, 10));
    child.writeOut([stepStart, textEvent('{"verdict": "bananas"}'), stepFinish].join("\n") + "\n");
    child.close(0);
    await expect(resultPromise).rejects.toMatchObject({
      code: "invalid_output",
      detail: expect.stringContaining("verdict must be approve|request_changes"),
    });
  });

  it("secrets never leak into error details or parsed text", async () => {
    process.env.MODEL_API_KEY = "sk-live-abcdef123456";
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const { session } = await startedSession(runtime);
    const resultPromise = runtime.execute(session, { instruction: "x", output: "text" });
    await new Promise((r) => setTimeout(r, 10));
    child.stderr.emit("data", Buffer.from("fatal: key sk-live-abcdef123456 rejected; authorization: Bearer sk-live-abcdef123456"));
    child.close(1);
    const err = await resultPromise.catch((e: AgentRuntimeError) => e);
    expect(err.code).toBe("crash");
    expect(err.detail).toBeDefined();
    expect(err.detail).not.toContain("sk-live-abcdef123456");
    expect(err.detail).toContain("[redacted]");
    delete process.env.MODEL_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  it("reports healthy with the CLI version on exit 0", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const promise = runtime.healthCheck();
    await new Promise((r) => setTimeout(r, 10));
    child.writeOut("2.1.2\n");
    child.close(0);
    const health = await promise;
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain("2.1.2");
    expect(health.checkedAt).toBeTruthy();
  });

  it("reports unhealthy when the binary exits non-zero", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child);
    const promise = runtime.healthCheck();
    await new Promise((r) => setTimeout(r, 10));
    child.close(127);
    const health = await promise;
    expect(health.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Workspace integrity guard (compensation for the CLI permission gap)
// ---------------------------------------------------------------------------

describe("workspace integrity guard", () => {
  async function runExecute(
    runtime: OpenCodeAgentRuntime,
    session: AgentSession,
    child: FakeChild,
  ) {
    const promise = runtime.execute(session, { instruction: "x", output: "text" });
    await new Promise((r) => setTimeout(r, 10));
    child.writeOut([stepStart, textEvent("ok"), stepFinish].join("\n") + "\n");
    child.close(0);
    return promise;
  }

  it("factory createAgentRuntime returns the AgentRuntime abstraction", async () => {
    const { createAgentRuntime } = await import("../src/agent/index.js");
    const runtime = createAgentRuntime(baseConfig);
    expect(typeof runtime.startSession).toBe("function");
    expect(typeof runtime.execute).toBe("function");
    expect(typeof runtime.terminate).toBe("function");
    expect(typeof runtime.healthCheck).toBe("function");
  });

  it("passes when the workspace snapshot is unchanged", async () => {
    const child = new FakeChild();
    let snapshot = " M src/a.ts\n";
    const { runtime } = makeRuntime(child, {
      gitStatusImpl: async () => snapshot,
    });
    const { session } = await startedSession(runtime);
    const result = await runExecute(runtime, session, child);
    expect(result.text).toBe("ok");
  });

  it("fails with workspace_modified when the agent modified the workspace", async () => {
    const child = new FakeChild();
    let snapshot = "";
    const { runtime } = makeRuntime(child, {
      gitStatusImpl: async () => snapshot,
    });
    const { session } = await startedSession(runtime);
    const promise = runExecute(runtime, session, child);
    // The agent "writes a file" mid-run; the post-run snapshot differs.
    snapshot = "?? hacked.txt\n";
    await expect(promise).rejects.toMatchObject({
      code: "workspace_modified",
      message: expect.stringContaining("modified the review workspace"),
      detail: expect.stringContaining("hacked.txt"),
    });
  });

  it("skips the guard when git is unavailable (snapshot undefined)", async () => {
    const child = new FakeChild();
    const { runtime } = makeRuntime(child, {
      gitStatusImpl: async () => undefined,
    });
    const { session } = await startedSession(runtime);
    const result = await runExecute(runtime, session, child);
    expect(result.text).toBe("ok");
  });
});
