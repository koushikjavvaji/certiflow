import type { Db } from "./db";
import type { AuthUser } from "./middleware/authenticate";

export interface AuditEntry {
  actor: Pick<AuthUser, "id" | "name"> | null; // null = the system (worker / scheduler)
  action: string; // e.g. BATCH_SUBMITTED, STEP_APPROVED, CERTIFICATE_CANCELLED
  entityType: "Batch" | "Certificate" | "Candidate";
  entityId: string;
  batchId?: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string; // request id / job id: lets one story be followed across API and worker logs
}

// Always called with the SAME transaction as the change it describes, so a decision and
// its record are saved together or not at all. The table is append-only (DB trigger).
export function writeAudit(db: Db, e: AuditEntry) {
  return db.auditLog.create({
    data: {
      actorId: e.actor?.id ?? null,
      actorName: e.actor?.name ?? null,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      batchId: e.batchId ?? null,
      reason: e.reason ?? null,
      metadata: (e.metadata ?? {}) as object,
      correlationId: e.correlationId ?? null,
    },
  });
}
