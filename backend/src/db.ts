import { Prisma, PrismaClient } from "@prisma/client";
import type { AuthUser } from "./auth";

// Two clients sharing ONE connection pool and ONE engine:
//   rawPrisma  sees EVERYTHING, including soft-deleted (isActive = false) rows. Use only for seeding,
//              tests and deliberate admin tooling.
//   prisma     the one application code uses. It automatically
//                - hides rows where isActive is false (reads), and
//                - turns delete()/deleteMany() into "set isActive = false" (soft delete).
//              Models without an isActive column (append-only tables added later,
//              like AuditLog) are left alone, so this needs no per-table wiring.
export const rawPrisma = new PrismaClient();

const SOFT_DELETE_MODELS = new Set(
  Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === "isActive")).map((m) => m.name),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (model: string): any => (rawPrisma as any)[lowerFirst(model)];

function hideDeleted(model: string, args: AnyArgs): AnyArgs {
  if (!SOFT_DELETE_MODELS.has(model)) return args;
  return { ...args, where: { ...(args?.where ?? {}), isActive: true } };
}

export const prisma = rawPrisma.$extends({
  name: "soft-delete",
  query: {
    $allModels: {
      findMany: ({ model, args, query }) => query(hideDeleted(model, args)),
      findFirst: ({ model, args, query }) => query(hideDeleted(model, args)),
      findFirstOrThrow: ({ model, args, query }) => query(hideDeleted(model, args)),
      findUnique: ({ model, args, query }) => query(hideDeleted(model, args)),
      findUniqueOrThrow: ({ model, args, query }) => query(hideDeleted(model, args)),
      count: ({ model, args, query }) => query(hideDeleted(model, args)),
      aggregate: ({ model, args, query }) => query(hideDeleted(model, args)),
      groupBy: ({ model, args, query }) => query(hideDeleted(model, args) as AnyArgs),
      updateMany: ({ model, args, query }) => query(hideDeleted(model, args)),
      async delete({ model, args, query }) {
        if (!SOFT_DELETE_MODELS.has(model)) return query(args);
        return delegate(model).update({ where: args.where, data: { isActive: false } });
      },
      async deleteMany({ model, args, query }) {
        if (!SOFT_DELETE_MODELS.has(model)) return query(args);
        return delegate(model).updateMany({
          where: { ...(args?.where ?? {}), isActive: true },
          data: { isActive: false },
        });
      },
    },
  },
});

// Type of "something you can run queries on": the client itself or a transaction.
export type Db = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

// ============ The audit log ============
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

export async function disconnectDb() {
  await rawPrisma.$disconnect();
}
