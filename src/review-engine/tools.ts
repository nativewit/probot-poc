/**
 * Controlled repository tool-request protocol (ticket 07; ARCHITECTURE.md
 * §5.2, §10.1).
 *
 * The agent NEVER touches the filesystem or network itself for repository
 * content. It may only *request* tools by listing workspace-relative paths;
 * the application resolves every path through the path-safe workspace
 * resolvers (symlinks and `..` rejected) under an enforced retrieval budget.
 *
 * Repository content is untrusted: every request is parsed defensively and a
 * malformed or malicious request is recorded as a violation, never thrown
 * into the agent's control flow.
 */

import fs from "node:fs/promises";
import {
  FileNotFoundError,
  FileTooLargeError,
  PathEscapeError,
  readWorkspaceFile,
  resolveWorkspacePath,
} from "../workspace/files.js";

export type ToolName = "read_file" | "list_files" | "get_diff";

export interface ToolRequest {
  tool: ToolName;
  /** Workspace-relative path (read_file, list_files). */
  path?: string;
  /** When true, the agent asks for the PR diff again (get_diff). */
  includeDiff?: boolean;
}

export type ToolResult =
  | { ok: true; tool: ToolName; path?: string; content: string; truncated: boolean }
  | { ok: false; tool: ToolName; path?: string; error: string };

/** Upper bound on one directory listing (names only, sorted). */
const MAX_LISTED_ENTRIES = 200;
/** Upper bound of the per-call context block, in characters. */
export const MAX_CONTEXT_CHARS = 48_000;

/**
 * Mutable retrieval budget shared across the whole review. Enforced here —
 * the agent cannot raise it.
 */
export class RetrievalBudget {
  used = 0;
  readonly violations: string[] = [];

  constructor(public readonly max: number) {}

  get exhausted(): boolean {
    return this.used >= this.max;
  }

  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }

  consume(): boolean {
    if (this.exhausted) return false;
    this.used++;
    return true;
  }

  violation(message: string): void {
    this.violations.push(message);
  }
}

/**
 * Parse the agent's tool requests defensively. Anything that is not a
 * well-formed request object with a known tool name is recorded as a
 * violation and dropped — unknown tool names (e.g. shell, network, write)
 * are always rejected.
 */
export function parseToolRequests(value: unknown, budget: RetrievalBudget): ToolRequest[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    budget.violation("tool_requests: not an array; ignored");
    return [];
  }
  const requests: ToolRequest[] = [];
  for (const raw of value.slice(0, 20)) {
    if (typeof raw !== "object" || raw === null) {
      budget.violation("tool request: not an object; ignored");
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const tool = candidate.tool;
    if (tool !== "read_file" && tool !== "list_files" && tool !== "get_diff") {
      budget.violation(`tool request: unsupported tool '${String(tool)}'; rejected`);
      continue;
    }
    const path = typeof candidate.path === "string" ? candidate.path : undefined;
    if ((tool === "read_file" || tool === "list_files") && !path) {
      budget.violation(`tool request '${tool}': missing path; rejected`);
      continue;
    }
    if (path !== undefined && (path.length === 0 || path.length > 512)) {
      budget.violation(`tool request '${tool}': path length out of bounds; rejected`);
      continue;
    }
    requests.push({ tool, path, includeDiff: candidate.includeDiff === true });
  }
  return requests;
}

/** Render a ToolResult into the context block handed back to the agent. */
function renderResult(result: ToolResult): string {
  if (!result.ok) {
    return `[${result.tool}${result.path ? ` ${result.path}` : ""}] NOT AVAILABLE: ${result.error}`;
  }
  const header = result.path ? `[${result.tool} ${result.path}${result.truncated ? " (truncated)" : ""}]` : `[${result.tool}]`;
  return `${header}\n${result.content}`;
}

/** list_files: names-only directory listing inside the workspace. */
async function listFiles(workspacePath: string, relativePath: string): Promise<string> {
  const resolved = resolveWorkspacePath(workspacePath, relativePath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const names = entries
    .slice(0, MAX_LISTED_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
  const truncated = entries.length > MAX_LISTED_ENTRIES;
  return names.join("\n") + (truncated ? `\n(${entries.length - MAX_LISTED_ENTRIES} more entries omitted)` : "");
}

/**
 * Fulfil tool requests under the budget. Path-escape attempts, oversized
 * files, budget exhaustion and missing files become per-request error
 * results plus violations — they never crash the review and never give the
 * agent control.
 */
export async function fulfillToolRequests(
  workspacePath: string,
  requests: ToolRequest[],
  budget: RetrievalBudget,
  diff: string,
  maxFileBytes: number,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const request of requests) {
    if (budget.exhausted) {
      budget.violation(`retrieval budget exhausted; '${request.tool}' request dropped`);
      results.push({ ok: false, tool: request.tool, path: request.path, error: "budget_exhausted" });
      continue;
    }
    try {
      let content: string;
      let truncated = false;
      if (request.tool === "get_diff") {
        content = diff;
      } else if (request.tool === "list_files") {
        content = await listFiles(workspacePath, request.path!);
      } else {
        const file = await readWorkspaceFile(workspacePath, request.path!, { maxFileBytes });
        if (file.encoding === "binary") {
          results.push({ ok: false, tool: request.tool, path: request.path, error: "binary_file" });
          budget.violation(`read_file ${request.path}: binary content withheld`);
          continue;
        }
        content = file.text ?? "";
      }
      budget.consume();
      if (content.length > MAX_CONTEXT_CHARS) {
        content = content.slice(0, MAX_CONTEXT_CHARS);
        truncated = true;
      }
      results.push({ ok: true, tool: request.tool, path: request.path, content, truncated });
    } catch (error) {
      const reason =
        error instanceof PathEscapeError
          ? "path_escape"
          : error instanceof FileTooLargeError
            ? "file_too_large"
            : error instanceof FileNotFoundError
              ? "not_found"
              : "unreadable";
      budget.violation(`${request.tool} ${request.path ?? ""}: ${reason}`.trim());
      results.push({ ok: false, tool: request.tool, path: request.path, error: reason });
    }
  }
  return results;
}

/** Render fulfilled results as the next instruction's context section. */
export function renderToolContext(results: ToolResult[]): string {
  if (results.length === 0) return "";
  return results.map(renderResult).join("\n\n");
}
