import type { PrismaClient } from "@prisma/client";

/**
 * Audit logging for administrative and security events (§13.1 audit_logs).
 * Audit writes are best-effort but awaited; failures are logged and surfaced
 * to the caller so a failed audit trail can fail the administrative request.
 */

export type AuditAction =
  | "admin.login"
  | "admin.login_denied"
  | "admin.logout"
  | "config.update"
  | "config.update_rejected"
  | "config.reload"
  | "config.rollback"
  | "config.rollback_failed";

export interface AuditEntry {
  actor: string;
  action: AuditAction;
  resource: string;
  metadata?: Record<string, unknown>;
}

export async function recordAuditLog(
  prisma: PrismaClient,
  entry: AuditEntry,
  logger?: { warn?: (obj: unknown, msg: string) => void },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        resource: entry.resource,
        metadata: (entry.metadata ?? undefined) as never,
      },
    });
  } catch (error) {
    // Never log metadata contents blindly — callers must already keep secrets
    // out of metadata. Report only the failure itself.
    logger?.warn?.({ err: (error as Error).message, action: entry.action }, "Audit log write failed");
    throw error;
  }
}
