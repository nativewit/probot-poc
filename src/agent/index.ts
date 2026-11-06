/**
 * Agent runtime module barrel (ARCHITECTURE.md §8).
 * Application code imports the abstraction from here, never the CLI adapter
 * directly, so the runtime implementation stays swappable.
 */

export {
  AgentRuntimeError,
  type AgentErrorCode,
  type AgentResult,
  type AgentRuntime,
  type AgentSession,
  type AgentSessionOptions,
  type AgentTask,
  type RuntimeHealth,
} from "./types.js";

export {
  buildChildEnv,
  buildPermissionRules,
  buildSessionConfig,
  resolveModelId,
  TOOL_ACTION_MAP,
  type AgentRuntimeConfigSource,
} from "./opencode-config.js";

export {
  createAgentRuntime,
  extractJson,
  OpenCodeAgentRuntime,
  type AgentRuntimeLogger,
  type OpenCodeRuntimeOptions,
} from "./opencode-runtime.js";
