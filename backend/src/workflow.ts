import type { AuthUser } from "./auth";
import { Handler, HttpError, chainOf, conflict, forbidden, notFound } from "./chain";
import { getActiveWorkflow, getSetting, getWorkflow, type WorkflowStepConfig } from "./config-store";
import { logger } from "./config";
import { prisma, type Db, writeAudit } from "./db";
import { enqueueBatchApproved, publishLive } from "./redis";

// The approval engine. It knows NOTHING about "2 district officers" or "50 candidates": those come
// from the WorkflowStep rows in the database. Three parts, top to bottom:
//   1. STEPS      each row becomes a StepHandler; the handlers are linked into a chain
//   2. DECISIONS  an approve / send back / reject / withdraw request is passed down a chain of
//                 small handlers: gatekeepers first (can you see it? is it your turn?), then the doer
//   3. ENTRY POINTS  submitBatch, decide, withdrawApproval (what the routes call)

// ======================================== 1. STEPS ========================================
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
  step: Pick<WorkflowStepConfig, "role" | "scope">,
  batch: { centre: { districtId: string } },
): boolean {
  if (user.role !== step.role) return false;
  if (step.scope === "DISTRICT") return user.districtId === batch.centre.districtId;
  return true;
}

// THE APPROVAL PATH AS A CHAIN OF HANDLERS.
//
// Each row of the WorkflowStep table becomes one StepHandler, and every handler points to
// the next one. A batch is "held" by one handler at a time; when that handler is
// satisfied it hands the batch on to the next handler that applies to it.
//
// The chain is built from the DATABASE at run time, so adding a step is adding a row:
// there is no handler class to write.
export class StepHandler {
  next: StepHandler | null = null;

  constructor(readonly config: WorkflowStepConfig) {}

  get key() {
    return this.config.key;
  }

  // Does this step apply to a batch of this size? {"minCandidates": 50} = only 50 or more.
  appliesTo(candidateCount: number): boolean {
    const min = this.config.condition?.minCandidates;
    return typeof min !== "number" || candidateCount >= min;
  }

  // Is it this person's turn at this step? (right role, and right district if scoped)
  canBeActedBy(user: AuthUser, batch: { centre: { districtId: string } }): boolean {
    return canActAtStep(user, this.config, batch);
  }

  // Have enough different people approved to pass the batch on?
  isSatisfiedBy(approvals: number): boolean {
    return approvals >= this.config.requiredApprovals;
  }

  // Who takes the batch next? Steps that do not apply to this batch are skipped.
  nextApplicable(candidateCount: number): StepHandler | null {
    let step = this.next;
    while (step && !step.appliesTo(candidateCount)) step = step.next;
    return step;
  }
}

export class StepChain {
  private readonly head: StepHandler | null;
  private readonly byKey = new Map<string, StepHandler>();

  // `configs` are WorkflowStep rows of one workflow version; they are linked in position order.
  constructor(configs: WorkflowStepConfig[]) {
    const handlers = [...configs].sort((a, b) => a.position - b.position).map((c) => new StepHandler(c));
    handlers.forEach((h, i) => {
      h.next = handlers[i + 1] ?? null;
      this.byKey.set(h.key, h);
    });
    this.head = handlers[0] ?? null;
  }

  get(key: string | null): StepHandler | null {
    return key ? (this.byKey.get(key) ?? null) : null;
  }

  // The step a brand-new submission starts at (null = nothing applies: straight to approved).
  first(candidateCount: number): StepHandler | null {
    if (!this.head) return null;
    return this.head.appliesTo(candidateCount) ? this.head : this.head.nextApplicable(candidateCount);
  }

  // Where a resubmitted batch picks up again: the step that sent it back, if it still applies.
  resume(key: string | null, candidateCount: number): StepHandler | null {
    const step = this.get(key);
    return step && step.appliesTo(candidateCount) ? step : this.first(candidateCount);
  }
}

// ======================================== 2. DECISIONS ========================================
export interface Ctx {
  user: AuthUser;
  correlationId?: string;
}

export type Decision = "APPROVE" | "SEND_BACK" | "REJECT";

export async function lockBatch(tx: Db, batchId: string) {
  // Row lock: two requests changing the same batch are served one after the other, and
  // the second one sees what the first one did. This is what makes "two officers approve
  // at the same moment" move the batch forward exactly once.
  await (tx as unknown as typeof prisma).$queryRaw`SELECT id FROM "Batch" WHERE id = ${batchId}::uuid FOR UPDATE`;
  return tx.batch.findUnique({ where: { id: batchId }, include: { centre: { select: { districtId: true } } } });
}

export type LockedBatch = NonNullable<Awaited<ReturnType<typeof lockBatch>>>;

// What travels down the chain for ONE request. The handlers themselves keep no state.
export interface DecisionContext {
  tx: Db; // the open database transaction
  user: AuthUser;
  batchId: string;
  correlationId?: string;
  decision?: Decision;
  reason?: string;
  // filled in by the handlers as the request moves along:
  batch?: LockedBatch;
  step?: StepHandler;
  // the answer the caller needs afterwards:
  finalApproval: boolean;
}

type H = Handler<DecisionContext>;
const batchOf = (c: DecisionContext) => c.batch as LockedBatch;
const stepOf = (c: DecisionContext) => c.step as StepHandler;
const auditBase = (c: DecisionContext) => ({
  actor: c.user,
  entityType: "Batch" as const,
  entityId: c.batchId,
  batchId: c.batchId,
  correlationId: c.correlationId,
});

// ============ PART 1: the gatekeepers. Each one checks one thing, then passes the request on. ============

// 1. Lock the batch row and load it.
class LoadBatch extends Handler<DecisionContext> {
  protected async process(c: DecisionContext) {
    const batch = await lockBatch(c.tx, c.batchId);
    if (!batch) throw notFound("batch not found");
    c.batch = batch;
    return false;
  }
}

// 2. Can this person even see the batch? If not it "does not exist" for them.
class CheckVisibility extends Handler<DecisionContext> {
  protected process(c: DecisionContext) {
    if (!canView(c.user, batchOf(c))) throw notFound("batch not found");
    return false;
  }
}

// 3. Is the batch actually waiting for a review?
class CheckInReview extends Handler<DecisionContext> {
  protected process(c: DecisionContext) {
    const batch = batchOf(c);
    if (batch.status !== "IN_REVIEW" || !batch.currentStepKey) throw conflict("this batch is not waiting for a review");
    return false;
  }
}

// 4. Which step is it at? (the step handler, built from the database rows)
class ResolveStep extends Handler<DecisionContext> {
  protected async process(c: DecisionContext) {
    const batch = batchOf(c);
    const step = new StepChain(await getWorkflow(batch.workflowVersion)).get(batch.currentStepKey);
    if (!step) throw conflict("the approval path for this batch is misconfigured");
    c.step = step;
    return false;
  }
}

// 5. Is it THIS person's turn? Wrong role, wrong district, or the batch has already moved on
//    to a step that is not theirs: refused, whatever the screen showed.
class CheckTurn extends Handler<DecisionContext> {
  protected process(c: DecisionContext) {
    if (!stepOf(c).canBeActedBy(c.user, batchOf(c))) throw forbidden("it is not your turn on this batch");
    return false;
  }
}

// ============ PART 2: the doers. Each one handles ONE kind of decision; others pass it along. ============

class ApproveHandler extends Handler<DecisionContext> {
  protected async process(c: DecisionContext) {
    if (c.decision !== "APPROVE") return false; // not mine: pass it on
    const { tx, user } = c;
    const batch = batchOf(c);
    const step = stepOf(c);

    // The INSERT only returns a row if this officer has not already approved this step of
    // this version (or had withdrawn it), so approving twice is refused.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "Approval" (id, "batchId", "batchVersion", "stepKey", "officerId", "createdById", "updatedById", "updatedAt")
      VALUES (gen_random_uuid(), ${batch.id}::uuid, ${batch.version}, ${step.key}, ${user.id}::uuid, ${user.id}::uuid, ${user.id}::uuid, now())
      ON CONFLICT ("batchId", "batchVersion", "stepKey", "officerId")
      DO UPDATE SET "isActive" = true, "updatedAt" = now(), "updatedById" = ${user.id}::uuid
      WHERE "Approval"."isActive" = false
      RETURNING id`;
    if (inserted.length === 0) throw conflict("you have already approved this step");

    const have = await tx.approval.count({
      where: { batchId: batch.id, batchVersion: batch.version, stepKey: step.key },
    });
    await writeAudit(tx, {
      ...auditBase(c),
      action: "STEP_APPROVED",
      metadata: { step: step.key, version: batch.version, approvals: have, required: step.config.requiredApprovals },
    });
    if (!step.isSatisfiedBy(have)) return true; // still waiting for more people

    // Enough people agreed: hand the batch to the NEXT handler in the chain (we hold the row lock).
    const next = step.nextApplicable(batch.candidateCount);
    if (next) {
      await tx.batch.update({
        where: { id: batch.id },
        data: { currentStepKey: next.key, stepEnteredAt: new Date(), overdueAt: null, updatedById: user.id },
      });
      await writeAudit(tx, { ...auditBase(c), action: "STEP_COMPLETED", metadata: { from: step.key, to: next.key } });
    } else {
      // End of the chain: nobody is left to ask, so the batch is approved.
      await tx.batch.update({
        where: { id: batch.id },
        data: { status: "APPROVED", currentStepKey: null, stepEnteredAt: null, overdueAt: null, updatedById: user.id },
      });
      await writeAudit(tx, { ...auditBase(c), action: "BATCH_APPROVED", metadata: { lastStep: step.key } });
      c.finalApproval = true;
    }
    return true;
  }
}

class SendBackHandler extends Handler<DecisionContext> {
  protected async process(c: DecisionContext) {
    if (c.decision !== "SEND_BACK") return false;
    const batch = batchOf(c);
    await c.tx.batch.update({
      where: { id: batch.id },
      data: { status: "CHANGES_REQUESTED", lastReason: c.reason ?? null, overdueAt: null, updatedById: c.user.id },
    });
    await writeAudit(c.tx, {
      ...auditBase(c),
      action: "BATCH_SENT_BACK",
      reason: c.reason,
      metadata: { step: stepOf(c).key, version: batch.version },
    });
    return true;
  }
}

class RejectHandler extends Handler<DecisionContext> {
  protected async process(c: DecisionContext) {
    if (c.decision !== "REJECT") return false;
    const batch = batchOf(c);
    await c.tx.batch.update({
      where: { id: batch.id },
      data: {
        status: "REJECTED",
        lastReason: c.reason ?? null,
        currentStepKey: null,
        stepEnteredAt: null,
        overdueAt: null,
        updatedById: c.user.id,
      },
    });
    // A rejected batch is closed, so its people become free to be submitted again.
    await c.tx.candidate.updateMany({ where: { batchId: batch.id }, data: { isActive: false } });
    await writeAudit(c.tx, {
      ...auditBase(c),
      action: "BATCH_REJECTED",
      reason: c.reason,
      metadata: { step: stepOf(c).key },
    });
    return true;
  }
}

// The end of the chain: a decision nobody recognised.
class UnknownDecision extends Handler<DecisionContext> {
  protected process(c: DecisionContext): boolean {
    throw new HttpError(400, `unknown decision: ${String(c.decision)}`);
  }
}

// A different "doer" for the withdraw request. It reuses the SAME gatekeepers.
class WithdrawHandler extends Handler<DecisionContext> {
  protected async process(c: DecisionContext) {
    const batch = batchOf(c);
    const step = stepOf(c);
    const { count } = await c.tx.approval.updateMany({
      where: { batchId: batch.id, batchVersion: batch.version, stepKey: step.key, officerId: c.user.id },
      data: { isActive: false, updatedById: c.user.id },
    });
    if (count === 0) throw conflict("you have no approval to withdraw at this step");
    await writeAudit(c.tx, {
      ...auditBase(c),
      action: "APPROVAL_WITHDRAWN",
      metadata: { step: step.key, version: batch.version },
    });
    return true;
  }
}

// The chains. Handlers are stateless, so each chain is built ONCE and shared by all requests.
const gatekeepers = (): H[] => [
  new LoadBatch(),
  new CheckVisibility(),
  new CheckInReview(),
  new ResolveStep(),
  new CheckTurn(),
];

export const decisionChain: H = chainOf(
  ...(gatekeepers() as [H, ...H[]]),
  new ApproveHandler(),
  new SendBackHandler(),
  new RejectHandler(),
  new UnknownDecision(),
);
export const withdrawChain: H = chainOf(...(gatekeepers() as [H, ...H[]]), new WithdrawHandler());

// ======================================== 3. ENTRY POINTS ========================================
// The approval engine. It knows NOTHING about "2 district officers" or "50 candidates":
// those come from the WorkflowStep rows, turned into a chain of StepHandlers
// (step-chain.ts). A request (approve / send back / reject / withdraw) is then passed down
// a chain of small handlers (decision-chain.ts), each doing one job.

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
    const chain = new StepChain(resubmit ? await getWorkflow(version) : active.steps);

    // Decision (documented in the README): when a sent-back batch is resubmitted, earlier
    // approvals are discarded (version bumps, review restarts from the first step),
    // because the data changed. A setting can switch this off to resume at the same step.
    const reset = resubmit ? await getSetting<boolean>("resubmit.resetApprovals", true) : true;
    const newVersion = resubmit && reset ? batch.version + 1 : batch.version;
    const start =
      !reset && resubmit ? chain.resume(batch.currentStepKey, batch.candidateCount) : chain.first(batch.candidateCount);

    const now = new Date();
    const shared = {
      workflowVersion: version,
      version: newVersion,
      overdueAt: null,
      lastReason: null,
      submittedAt: batch.submittedAt ?? now,
      updatedById: user.id,
    };
    if (!start) {
      // an empty chain: nobody to ask, so it is approved at once
      await tx.batch.update({
        where: { id: batch.id },
        data: { ...shared, status: "APPROVED", currentStepKey: null, stepEnteredAt: null },
      });
    } else {
      await tx.batch.update({
        where: { id: batch.id },
        data: { ...shared, status: "IN_REVIEW", currentStepKey: start.key, stepEnteredAt: now },
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
  let finalApproval = false;
  await prisma.$transaction(async (tx) => {
    const context: DecisionContext = {
      tx,
      user: ctx.user,
      batchId,
      correlationId: ctx.correlationId,
      decision,
      reason,
      finalApproval: false,
    };
    await decisionChain.handle(context);
    finalApproval = context.finalApproval;
  });
  await finishAfterCommit(batchId, finalApproval, ctx.correlationId);
}

// ---------------------------------------------------------------------------------
// Officers make mistakes: take back your own approval while the batch is still at that step
// ---------------------------------------------------------------------------------
export async function withdrawApproval(batchId: string, ctx: Ctx) {
  await prisma.$transaction(async (tx) => {
    await withdrawChain.handle({ tx, user: ctx.user, batchId, correlationId: ctx.correlationId, finalApproval: false });
  });
  await publishLive({ type: "batch.updated", batchId });
}

// After the transaction has COMMITTED: tell the browsers, and (for a final approval) start issuing.
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
