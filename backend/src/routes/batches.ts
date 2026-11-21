import { Router } from "express";
import { z } from "zod";

import { authenticate, requireRole, type AuthUser } from "../auth";
import { Handler, HttpError, chainOf, conflict, notFound } from "../chain";
import { getActiveWorkflow } from "../config-store";
import { parseCandidatesCsv, type ParsedCandidate, type RowError } from "../csv";
import { prisma, writeAudit } from "../db";
import { publishLive } from "../redis";
import { getBatchDetail, listBatches, type View } from "../view";
import { decide, submitBatch, withdrawApproval } from "../workflow";

export const batchesRouter = Router();
batchesRouter.use(authenticate); // mounted at /batches, so this only guards these routes

const idParam = z.object({ id: z.uuid() });
const reasonText = z.string().trim().min(3, "give a reason of at least 3 characters").max(500);
const ctx = (req: import("express").Request) => ({ user: req.user!, correlationId: String(req.id) });

// Centre: start a new batch.
batchesRouter.post("/", requireRole("CENTRE"), async (req, res) => {
  const { courseName } = z.object({ courseName: z.string().trim().min(2).max(100) }).parse(req.body);
  const user = req.user!;
  if (!user.centreId) throw new HttpError(403, "your account is not linked to a centre");
  const batch = await prisma.$transaction(async (tx) => {
    const b = await tx.batch.create({
      data: {
        centreId: user.centreId!,
        courseName,
        workflowVersion: (await getActiveWorkflow()).version,
        createdById: user.id,
      },
    });
    await writeAudit(tx, {
      actor: user,
      action: "BATCH_CREATED",
      entityType: "Batch",
      entityId: b.id,
      batchId: b.id,
      metadata: { courseName },
      correlationId: String(req.id),
    });
    return b;
  });
  await publishLive({ type: "batch.updated", batchId: batch.id });
  res.status(201).json({ id: batch.id });
});

// List: "waiting" = needs my action, "all" = everything I may see, "stuck" = overdue (state office).
batchesRouter.get("/", async (req, res) => {
  const user = req.user!;
  const { view } = z.object({ view: z.enum(["waiting", "all", "stuck"]).optional() }).parse(req.query);
  const chosen: View = view ?? (user.role === "CENTRE" ? "all" : "waiting");
  res.json({ batches: await listBatches(user, chosen) });
});

batchesRouter.get("/:id", async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await getBatchDetail(req.user!, id));
});

// ============ SPREADSHEET UPLOAD as a chain ============
// Does the batch belong to you? → can it still be edited? → read and check every row →
// is anyone already in another batch? → save everything in one transaction.
// ALL OR NOTHING: any problem stops the chain and NOTHING is saved.
interface UploadContext {
  batchId: string;
  csv: string;
  user: AuthUser;
  correlationId: string;
  rows: ParsedCandidate[];
  problems: RowError[];
}

class OwnBatch extends Handler<UploadContext> {
  protected async process(c: UploadContext) {
    const batch = await prisma.batch.findUnique({ where: { id: c.batchId } });
    if (!batch || batch.centreId !== c.user.centreId) throw notFound("batch not found");
    if (batch.status !== "DRAFT" && batch.status !== "CHANGES_REQUESTED")
      throw conflict(`a batch that is ${batch.status} cannot be edited`);
    return false;
  }
}

class ReadSheet extends Handler<UploadContext> {
  protected async process(c: UploadContext) {
    const { rows, errors } = await parseCandidatesCsv(c.csv); // runs the row-checking chain (csv.ts)
    c.rows = rows;
    c.problems = errors;
    return errors.length > 0; // problems: stop here, save nothing
  }
}

// Is any of these people already waiting for / holding a certificate for that course through
// ANOTHER batch? (The database enforces this too: see the unique index.)
class CheckOtherBatches extends Handler<UploadContext> {
  protected async process(c: UploadContext) {
    const byCourse = new Map<string, string[]>();
    for (const r of c.rows) byCourse.set(r.courseCode, [...(byCourse.get(r.courseCode) ?? []), r.phone]);
    const clashes = await prisma.candidate.findMany({
      where: {
        batchId: { not: c.batchId },
        OR: [...byCourse].map(([courseCode, phones]) => ({ courseCode, phone: { in: phones } })),
      },
      select: { courseCode: true, phone: true },
    });
    const taken = new Set(clashes.map((x) => `${x.courseCode}|${x.phone}`));
    for (const r of c.rows) {
      if (taken.has(`${r.courseCode}|${r.phone}`))
        c.problems.push({
          row: r.row,
          field: "phone",
          message: `already submitted for course ${r.courseCode} in another batch`,
        });
    }
    return c.problems.length > 0;
  }
}

class SaveAll extends Handler<UploadContext> {
  protected async process(c: UploadContext) {
    const { batchId: id, user, rows } = c;
    try {
      await prisma.$transaction(async (tx) => {
        await (tx as unknown as typeof prisma).$queryRaw`SELECT id FROM "Batch" WHERE id = ${id}::uuid FOR UPDATE`;
        const fresh = await tx.batch.findUnique({ where: { id } });
        if (!fresh || (fresh.status !== "DRAFT" && fresh.status !== "CHANGES_REQUESTED"))
          throw conflict("this batch can no longer be edited");
        await tx.candidate.updateMany({ where: { batchId: id }, data: { isActive: false } }); // replace, don't append
        await tx.candidate.createMany({
          data: rows.map((r) => ({
            batchId: id,
            name: r.name,
            phone: r.phone,
            courseCode: r.courseCode,
            marks: r.marks,
            createdById: user.id,
          })),
        });
        await tx.batch.update({ where: { id }, data: { candidateCount: rows.length, updatedById: user.id } });
        await writeAudit(tx, {
          actor: user,
          action: "CANDIDATES_UPLOADED",
          entityType: "Batch",
          entityId: id,
          batchId: id,
          metadata: { count: rows.length },
          correlationId: c.correlationId,
        });
      });
    } catch (err) {
      // Lost a race against another upload that took the same person: the DB index said no.
      if ((err as { code?: string }).code === "P2002")
        throw conflict("one of these candidates was just added in another batch; check the sheet and try again");
      throw err;
    }
    await publishLive({ type: "batch.updated", batchId: id });
    return true;
  }
}

const uploadChain = chainOf<UploadContext>(new OwnBatch(), new ReadSheet(), new CheckOtherBatches(), new SaveAll());

// Centre: replace the batch's candidates from a spreadsheet (CSV text).
batchesRouter.put("/:id/candidates", requireRole("CENTRE"), async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { csv } = z.object({ csv: z.string().min(1).max(2_000_000) }).parse(req.body);
  const context: UploadContext = {
    batchId: id,
    csv,
    user: req.user!,
    correlationId: String(req.id),
    rows: [],
    problems: [],
  };
  await uploadChain.handle(context);
  if (context.problems.length > 0) {
    res.status(422).json({
      error: "validation_failed",
      totalErrors: context.problems.length,
      errors: context.problems.slice(0, 200),
    });
    return;
  }
  res.json({ saved: context.rows.length });
});

batchesRouter.post("/:id/submit", requireRole("CENTRE"), async (req, res) => {
  await submitBatch(idParam.parse(req.params).id, ctx(req));
  res.json({ ok: true });
});

const decisionBody = z
  .object({ decision: z.enum(["APPROVE", "SEND_BACK", "REJECT"]), reason: reasonText.optional() })
  .refine((b) => b.decision === "APPROVE" || !!b.reason, {
    message: "a reason is required to send back or reject",
    path: ["reason"],
  });

batchesRouter.post("/:id/decision", requireRole("DISTRICT_OFFICER", "QUALITY", "STATE"), async (req, res) => {
  const { decision, reason } = decisionBody.parse(req.body);
  await decide(idParam.parse(req.params).id, decision, reason, ctx(req));
  res.json({ ok: true });
});

batchesRouter.post("/:id/withdraw", requireRole("DISTRICT_OFFICER", "QUALITY", "STATE"), async (req, res) => {
  await withdrawApproval(idParam.parse(req.params).id, ctx(req));
  res.json({ ok: true });
});
