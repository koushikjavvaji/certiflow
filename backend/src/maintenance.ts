import { writeAudit } from "./audit";
import { getWorkflow } from "./config-store";
import { prisma } from "./db";
import { fanOutIssuance } from "./issuance";
import { publishLive } from "./live";

// Safety net for work the event might have missed (API crashed after approving but before
// queueing, Redis was restarted, ...): re-offer every APPROVED / ISSUING batch. Cheap and
// idempotent, because each candidate's job has a fixed id.
export async function sweepIssuance(): Promise<number> {
  const batches = await prisma.batch.findMany({ where: { status: { in: ["APPROVED", "ISSUING"] } }, select: { id: true } });
  let queued = 0;
  for (const b of batches) queued += await fanOutIssuance(b.id);
  return queued;
}

// "Files sitting with an officer for days": any batch waiting longer than its step's SLA
// is flagged ONCE (overdueAt), recorded in the audit log, and announced live. The state
// office sees it in its "stuck" list without anyone chasing. SLA minutes are data
// (WorkflowStep.slaMinutes), so lowering one in the database takes effect on the next scan.
export async function scanOverdue(now = new Date()): Promise<number> {
  const waiting = await prisma.batch.findMany({
    where: { status: "IN_REVIEW", overdueAt: null, stepEnteredAt: { not: null }, currentStepKey: { not: null } },
  });
  let flagged = 0;
  for (const batch of waiting) {
    const step = (await getWorkflow(batch.workflowVersion)).find((s) => s.key === batch.currentStepKey);
    if (!step?.slaMinutes || !batch.stepEnteredAt) continue;
    const waitedMinutes = Math.floor((now.getTime() - batch.stepEnteredAt.getTime()) / 60_000);
    if (waitedMinutes < step.slaMinutes) continue;

    // Conditional update: even with several scanners running, only one flags it.
    const { count } = await prisma.batch.updateMany({
      where: { id: batch.id, status: "IN_REVIEW", overdueAt: null, currentStepKey: batch.currentStepKey },
      data: { overdueAt: now },
    });
    if (count === 0) continue;
    flagged++;
    await writeAudit(prisma, {
      actor: null,
      action: "BATCH_OVERDUE",
      entityType: "Batch",
      entityId: batch.id,
      batchId: batch.id,
      metadata: { step: step.key, waitedMinutes, slaMinutes: step.slaMinutes },
    });
    await publishLive({ type: "batch.overdue", batchId: batch.id });
  }
  return flagged;
}
