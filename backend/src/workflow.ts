import { writeAudit } from "./audit";
import { getActiveWorkflow, getSetting, getWorkflow, type WorkflowStepConfig } from "./config-store";
import { prisma, type Db } from "./db";
import { conflict, forbidden, HttpError, notFound } from "./errors";
import { publishLive } from "./live";
import type { AuthUser } from "./middleware/authenticate";
import { enqueueBatchApproved } from "./queues";
import { logger } from "./logger";

// The approval engine. It knows NOTHING about "2 district officers" or "50 candidates":
// those come from the WorkflowStep rows in the database. All this code does is follow
// whatever path the data describes.

export interface Ctx {
  user: AuthUser;
  correlationId?: string;
}

export type Decision = "APPROVE" | "SEND_BACK" | "REJECT";

// Steps that apply to a batch of this size, in order. A step's `condition`
// {"minCandidates": N} means "only for batches of N or more".
export function applicableSteps(steps: WorkflowStepConfig[], candidateCount: number): WorkflowStepConfig[] {
  return steps.filter((s) => {
    const min = s.condition?.minCandidates;
    return typeof min !== "number" || candidateCount >= min;
  });
}

// Can this person even SEE this batch? (Anything else is reported as "not found" so we
// never reveal that a batch exists.)
export function canView(user: AuthUser, batch: { centreId: string; centre: { districtId: string } }): boolean {
  switch (user.role) {
    case "CENTRE":
      return user.centreId === batch.centreId;
    case "DISTRICT_OFFICER":
      return user.districtId === batch.centre.districtId;
    default:
      return true; // quality team and state office work across all districts
  }
}

// Is it this person's turn? Role must match the step, and district-scoped steps also
// need the officer to belong to the batch's district.
export function canActAtStep(
  user: AuthUser,
  step: WorkflowStepConfig,
  batch: { centre: { districtId: string } },
): boolean {
  if (user.role !== step.role) return false;
  if (step.scope === "DISTRICT") return user.districtId === batch.centre.districtId;
  return true;
}

async function lockBatch(tx: Db, batchId: string) {
  // Row lock: two requests changing the same batch are served one after the other, and
  // the second one sees what the first one did. This is what makes "two officers approve
  // at the same moment" move the batch forward exactly once.
  await (tx as unknown as typeof prisma).$queryRaw`SELECT id FROM "Batch" WHERE id = ${batchId}::uuid FOR UPDATE`;
  return tx.batch.findUnique({ where: { id: batchId }, include: { centre: { select: { districtId: true } } } });
}

async function finishAfterCommit(batchId: string, approvedForIssuing: boolean, correlationId?: string) {
  await publishLive({ type: "batch.updated", batchId });
  if (approvedForIssuing) {
    try {
      await enqueueBatchApproved(batchId, correlationId);
    } catch (err) {
      // The batch is safely APPROVED in the database; the worker's periodic sweep picks it up.
      logger.error({ err, batchId }, "could not enqueue batch.approved; the sweep will retry");
    }
  }
}

// ---------------------------------------------------------------------------------
// Centre: send a batch for review (first time, or again after it was sent back)
// ---------------------------------------------------------------------------------
export async function submitBatch(batchId: string, ctx: Ctx) {
  const { user } = ctx;
  const approvedImmediately = await prisma.$transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!batch || user.role !== "CENTRE" || user.centreId !== batch.centreId) throw notFound("batch not found");
    if (batch.status !== "DRAFT" && batch.status !== "CHANGES_REQUESTED") {
      throw conflict(`a batch that is ${batch.status} cannot be submitted`);
    }
    if (batch.candidateCount < 1) throw new HttpError(422, "add candidates before submitting");

    const resubmit = batch.status === "CHANGES_REQUESTED";
    const active = await getActiveWorkflow();
    const version = resubmit ? batch.workflowVersion : active.version;
    const steps = resubmit ? await getWorkflow(version) : active.steps;
    const applicable = applicableSteps(steps, batch.candidateCount);

    // Decision (documented in the README): when a sent-back batch is resubmitted, earlier
    // approvals are discarded (version bumps, review restarts from the first step),
    // because the data changed. A setting can switch this off to resume at the same step.
    const reset = resubmit ? await getSetting<boolean>("resubmit.resetApprovals", true) : true;
    const newVersion = resubmit && reset ? batch.version + 1 : batch.version;
    const start = !reset && resubmit
      ? (applicable.find((s) => s.key === batch.currentStepKey) ?? applicable[0])
      : applicable[0];

    const now = new Date();
    if (!start) {
      await tx.batch.update({
        where: { id: batch.id },
        data: { status: "APPROVED", workflowVersion: version, version: newVersion, currentStepKey: null, stepEnteredAt: null, overdueAt: null, lastReason: null, submittedAt: batch.submittedAt ?? now, updatedById: user.id },
      });
    } else {
      await tx.batch.update({
        where: { id: batch.id },
        data: { status: "IN_REVIEW", workflowVersion: version, version: newVersion, currentStepKey: start.key, stepEnteredAt: now, overdueAt: null, lastReason: null, submittedAt: batch.submittedAt ?? now, updatedById: user.id },
      });
    }
    await writeAudit(tx, {
      actor: user,
      action: resubmit ? "BATCH_RESUBMITTED" : "BATCH_SUBMITTED",
      entityType: "Batch",
      entityId: batch.id,
      batchId: batch.id,
      metadata: { version: newVersion, firstStep: start?.key ?? null, approvalsReset: resubmit ? reset : undefined },
      correlationId: ctx.correlationId,
    });
    return !start;
  });
  await finishAfterCommit(batchId, approvedImmediately, ctx.correlationId);
}

// ---------------------------------------------------------------------------------
// Officers / quality / state: approve, send back or reject at the batch's current step
// ---------------------------------------------------------------------------------
export async function decide(batchId: string, decision: Decision, reason: string | undefined, ctx: Ctx) {
  const { user } = ctx;
  let finalApproval = false;

  await prisma.$transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!batch || !canView(user, batch)) throw notFound("batch not found");
    if (batch.status !== "IN_REVIEW" || !batch.currentStepKey) throw conflict("this batch is not waiting for a review");

    const steps = await getWorkflow(batch.workflowVersion);
    const step = steps.find((s) => s.key === batch.currentStepKey);
    if (!step) throw conflict("the approval path for this batch is misconfigured");
    // Acting at a step that is not yours (wrong role, wrong district, or the batch has
    // already moved on) is refused, whatever the UI showed.
    if (!canActAtStep(user, step, batch)) throw forbidden("it is not your turn on this batch");

    const base = { actor: user, entityType: "Batch" as const, entityId: batch.id, batchId: batch.id, correlationId: ctx.correlationId };

    if (decision === "SEND_BACK") {
      await tx.batch.update({ where: { id: batch.id }, data: { status: "CHANGES_REQUESTED", lastReason: reason ?? null, overdueAt: null, updatedById: user.id } });
      await writeAudit(tx, { ...base, action: "BATCH_SENT_BACK", reason, metadata: { step: step.key, version: batch.version } });
      return;
    }

    if (decision === "REJECT") {
      await tx.batch.update({ where: { id: batch.id }, data: { status: "REJECTED", lastReason: reason ?? null, currentStepKey: null, stepEnteredAt: null, overdueAt: null, updatedById: user.id } });
      // A rejected batch is closed, so its people become free to be submitted again.
      await tx.candidate.updateMany({ where: { batchId: batch.id }, data: { isActive: false } });
      await writeAudit(tx, { ...base, action: "BATCH_REJECTED", reason, metadata: { step: step.key } });
      return;
    }

    // APPROVE. The INSERT only returns a row if this officer has not already approved
    // this step of this version (or had withdrawn it), so approving twice is refused.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "Approval" (id, "batchId", "batchVersion", "stepKey", "officerId", "createdById", "updatedById", "updatedAt")
      VALUES (gen_random_uuid(), ${batch.id}::uuid, ${batch.version}, ${step.key}, ${user.id}::uuid, ${user.id}::uuid, ${user.id}::uuid, now())
      ON CONFLICT ("batchId", "batchVersion", "stepKey", "officerId")
      DO UPDATE SET "isActive" = true, "updatedAt" = now(), "updatedById" = ${user.id}::uuid
      WHERE "Approval"."isActive" = false
      RETURNING id`;
    if (inserted.length === 0) throw conflict("you have already approved this step");

    const have = await tx.approval.count({ where: { batchId: batch.id, batchVersion: batch.version, stepKey: step.key } });
    await writeAudit(tx, { ...base, action: "STEP_APPROVED", metadata: { step: step.key, version: batch.version, approvals: have, required: step.requiredApprovals } });
    if (have < step.requiredApprovals) return; // still waiting for more people

    // Enough people agreed: move on exactly once (we hold the row lock).
    const applicable = applicableSteps(steps, batch.candidateCount);
    const next = applicable[applicable.findIndex((s) => s.key === step.key) + 1];
    if (next) {
      await tx.batch.update({ where: { id: batch.id }, data: { currentStepKey: next.key, stepEnteredAt: new Date(), overdueAt: null, updatedById: user.id } });
      await writeAudit(tx, { ...base, action: "STEP_COMPLETED", metadata: { from: step.key, to: next.key } });
    } else {
      await tx.batch.update({ where: { id: batch.id }, data: { status: "APPROVED", currentStepKey: null, stepEnteredAt: null, overdueAt: null, updatedById: user.id } });
      await writeAudit(tx, { ...base, action: "BATCH_APPROVED", metadata: { lastStep: step.key } });
      finalApproval = true;
    }
  });

  await finishAfterCommit(batchId, finalApproval, ctx.correlationId);
}

// ---------------------------------------------------------------------------------
// Officers make mistakes: take back your own approval while the batch is still at that step
// ---------------------------------------------------------------------------------
export async function withdrawApproval(batchId: string, ctx: Ctx) {
  const { user } = ctx;
  await prisma.$transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!batch || !canView(user, batch)) throw notFound("batch not found");
    if (batch.status !== "IN_REVIEW" || !batch.currentStepKey) throw conflict("this batch is not waiting for a review");
    const step = (await getWorkflow(batch.workflowVersion)).find((s) => s.key === batch.currentStepKey);
    if (!step || !canActAtStep(user, step, batch)) throw forbidden("it is not your turn on this batch");

    const { count } = await tx.approval.updateMany({
      where: { batchId: batch.id, batchVersion: batch.version, stepKey: step.key, officerId: user.id },
      data: { isActive: false, updatedById: user.id },
    });
    if (count === 0) throw conflict("you have no approval to withdraw at this step");
    await writeAudit(tx, { actor: user, action: "APPROVAL_WITHDRAWN", entityType: "Batch", entityId: batch.id, batchId: batch.id, metadata: { step: step.key, version: batch.version }, correlationId: ctx.correlationId });
  });
  await publishLive({ type: "batch.updated", batchId });
}

