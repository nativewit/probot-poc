/**
 * OpenCode session configuration builder (ARCHITECTURE.md §8.1, §11.3).
 *
 * Builds the per-session `opencode.json` consumed by the OpenCode CLI. The
 * configuration is written to a session-owned directory (never into the
 * repository workspace) and never contains secrets: the model API key is
 * supplied through the documented `{env:...}`/`env` variable mechanisms and
 * read from the child-process environment, which is an explicit allowlist.
 *
 * Security invariants (§10.1):
 * - Repository content is untrusted: prompt-injection instructions in the
 *   repository can never widen these permissions, because the agent has no
 *   write access to this file and rules are deny-by-default.
 * - The agent may read files inside the review workspace only; all other
 *   tools/actions are denied.
 */

// Structural subset of the central review configuration (ticket 02) used here.
export interface AgentRuntimeConfigSource {
  provider: {
    type: string;
    baseURL: string;
    apiKeyEnv: string;
    model: string;
    temperature: number;
    maxOutputTokens: number;
    timeoutMs: number;
  };
  agent: {
    runtime: { type: "opencode-cli" | "opencode-server" | "custom"; sessionStrategy: string; timeoutMs: number };
    context: {
      adaptive: boolean;
      maxFiles: number;
      maxRetrievalCalls: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    };
    tools: { enabled: string[]; permissionPolicy: "allowlist" | "none" };
  };
}



/**
 * Map the central `agent.tools.enabled` allowlist (conceptual tool names from
 * §11.3) onto OpenCode V2 permission actions. Unknown names are ignored.
 *
 * Conceptual tool     OpenCode action   Notes
 * read_file           read              Read a file inside the workspace.
 * list_files          glob              Enumerate paths inside the workspace.
 * search_code         grep              Content search inside the workspace.
 * inspect_symbols     grep              Best-effort mapping (text search).
 * get_diff            read              Best-effort mapping (read workspace files).
 */
export const TOOL_ACTION_MAP: Record<string, string> = {
  read_file: "read",
  list_files: "glob",
  search_code: "grep",
  inspect_symbols: "grep",
  get_diff: "read",
};

/**
 * Build the OpenCode `permission` configuration for one session.
 *
 * Deny-by-default: the `*` catch-all denies every action, then only the
 * actions mapped from the tools allowlist are re-allowed. `read` is granular
 * (object syntax, last matching pattern wins) so mandatory secret-protection
 * denials override the allow. External directories are denied outright so the
 * agent is confined to the review workspace.
 */
export function buildPermissionRules(config: AgentRuntimeConfigSource): Record<string, unknown> {
  const permission: Record<string, unknown> = {
    // 1. Deny every action by default (bash, edit, write, webfetch, websearch,
    //    task/subagents, skill, lsp, question, mcp tools — everything).
    "*": "deny",
    // 2. Confine the agent to the review workspace.
    external_directory: "deny",
  };

  // 3. Re-allow only the mapped actions of the tools allowlist. `read` is
  //    granular: allow all paths, then append mandatory secret denials (last
  //    match wins in OpenCode pattern evaluation).
  if (config.agent.tools.permissionPolicy === "allowlist") {
    const actions = new Set<string>();
    for (const tool of config.agent.tools.enabled) {
      const action = TOOL_ACTION_MAP[tool];
      if (action) actions.add(action);
    }
    for (const action of actions) {
      if (action === "read") {
        permission.read = {
          "*": "allow",
          "*.env": "deny",
          "*.env.*": "deny",
          "*credential*": "deny",
          "*credentials*": "deny",
          ".git-credentials": "deny",
        };
      } else {
        permission[action] = "allow";
      }
    }
  }

  return permission;
}

/** Environment variables the OpenCode child process is allowed to inherit. */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

/**
 * Build the sanitized child-process environment. Only allowlisted variables
 * plus the model-provider credentials (by env-var name from the central
 * configuration) are passed — GitHub credentials and every other secret of
 * the trusted application are never visible to the agent (§10.6).
 */
export function buildChildEnv(config: AgentRuntimeConfigSource, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (env[name] !== undefined) child[name] = env[name];
  }
  // Provider credential + endpoint, referenced by configuration `env` field.
  const keyName = config.provider.apiKeyEnv;
  if (env[keyName] !== undefined) child[keyName] = env[keyName];
  if (env.MODEL_BASE_URL !== undefined) child.MODEL_BASE_URL = env.MODEL_BASE_URL;
  if (env.MODEL_NAME !== undefined) child.MODEL_NAME = env.MODEL_NAME;
  return child;
}

export interface OpenCodeSessionConfigInput {
  /** Session-owned directory that will hold config/ and data/ subdirectories. */
  sessionDir: string;
  workspacePath: string;
  config: AgentRuntimeConfigSource;
  /** Resolved model identifier sent to the provider endpoint. */
  modelId: string;
  /** Resolved output-token budget for the model. */
  maxOutputTokens: number;
}

/**
 * Build the per-session OpenCode configuration object (JSON, V2 schema).
 * Provider id "reviewer" is application-owned; the model key "glm" is a fixed
 * alias so that slashes in upstream model identifiers never collide with the
 * `provider/model` reference format.
 */
export function buildSessionConfig(input: OpenCodeSessionConfigInput): Record<string, unknown> {
  const { config } = input;
  return {
    $schema: "https://opencode.ai/config.json",
    model: "reviewer/glm",
    update: "disable",
    snapshots: false,
    permission: buildPermissionRules(config),
    providers: {
      reviewer: {
        name: "Review Model Provider",
        env: [config.provider.apiKeyEnv],
        npm: "@opencode/ai/providers/openai-compatible",
        options: {
          baseURL: config.provider.baseURL,
          apiKey: `{env:${config.provider.apiKeyEnv}}`,
          timeout: config.provider.timeoutMs,
        },
        models: {
          glm: {
            name: config.provider.model,
            modelID: input.modelId,
            limit: { context: config.agent.context.maxInputTokens, output: input.maxOutputTokens },
          },
        },
      },
    },
  };
}

/**
 * Resolve the model identifier actually sent to the endpoint. Per ticket 05:
 * the configured endpoint requires the "provider/model" MODEL_NAME form
 * (e.g. `workers-ai/@cf/zai-org/glm-4.7-flash`); the central
 * `provider.model` value is used as a fallback only.
 */
export function resolveModelId(config: AgentRuntimeConfigSource, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.MODEL_NAME?.trim();
  if (fromEnv) return fromEnv;
  return config.provider.model;
}
