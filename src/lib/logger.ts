import pino from "pino";
import type { Env } from "../config/env.js";

/**
 * Structured logging via Pino.
 *
 * Security: secrets (tokens, private keys, credentials) must never be
 * logged. The redact list catches common key names defensively, and
 * connection strings are only ever logged in sanitized form.
 */

const REDACTED = "[REDACTED]";

export const logRedactPaths = [
  // Object paths that commonly carry credentials.
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "privateKey",
  "private_key",
  "password",
  "secret",
  "clientSecret",
  "client_secret",
  "webhookSecret",
  "webhook_secret",
  "authorization",
  "DATABASE_URL",
  "REDIS_URL",
];

export function createLogger(env: Env): pino.Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: logRedactPaths,
      censor: REDACTED,
    },
    base: {
      service: "ai-pr-reviewer",
      environment: env.NODE_ENV,
    },
    // Pretty, human-readable output for local development only.
    transport:
      env.NODE_ENV === "production" || env.NODE_ENV === "test"
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              colorize: true,
              singleLine: true,
              // Never let the pretty printer print raw secret-bearing values
              // from base fields; redaction above still applies.
            },
          },
  });
}
