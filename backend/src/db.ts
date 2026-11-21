import { Prisma, PrismaClient } from "@prisma/client";

// Two clients sharing ONE connection pool and ONE engine:
//   rawPrisma  sees EVERYTHING, including soft-deleted rows. Use only for seeding,
//              tests and deliberate admin tooling.
//   prisma     the one application code uses. It automatically
//                - hides rows where deletedAt is set (reads), and
//                - turns delete()/deleteMany() into "set deletedAt" (soft delete).
//              Models without a deletedAt column (append-only tables added later,
//              like AuditLog) are left alone, so this needs no per-table wiring.
export const rawPrisma = new PrismaClient();

const SOFT_DELETE_MODELS = new Set(
  Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === "deletedAt")).map((m) => m.name),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (model: string): any => (rawPrisma as any)[lowerFirst(model)];

function hideDeleted(model: string, args: AnyArgs): AnyArgs {
  if (!SOFT_DELETE_MODELS.has(model)) return args;
  return { ...args, where: { ...(args?.where ?? {}), deletedAt: null } };
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
        return delegate(model).update({ where: args.where, data: { deletedAt: new Date() } });
      },
      async deleteMany({ model, args, query }) {
        if (!SOFT_DELETE_MODELS.has(model)) return query(args);
        return delegate(model).updateMany({
          where: { ...(args?.where ?? {}), deletedAt: null },
          data: { deletedAt: new Date() },
        });
      },
    },
  },
});

export async function disconnectDb() {
  await rawPrisma.$disconnect();
}
