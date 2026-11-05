/** Shared data models for chat interactions. */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** Result of an LLM chat call. */
export type ChatResult = string;
