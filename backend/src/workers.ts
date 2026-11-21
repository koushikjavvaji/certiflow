import { Worker, type Job } from "bullmq";

import { config, logger } from "./config";
import { getSetting, getWorkflow } from "./config-store";
import { prisma, writeAudit } from "./db";
import { fanOutIssuance, markDeliveryFailed, processIssue, type WhatsAppClient } from "./issuance";
import { QUEUE_EVENTS, QUEUE_ISSUANCE, QUEUE_MAINTENANCE, createBullConnection, getQueues, publishLive } from "./redis";

const SWEEP_EVERY_MS = 30_000; // how often approved-but-unfinished batches are re-offered
const DEFAULT_OVERDUE_SCAN_SECONDS = 15;
const MIN_OVERDUE_SCAN_SECONDS = 5;

// ============ Housekeeping jobs ============
// Safety net for work the event might have missed (API crashed after approving but before
// queueing, Redis was restarted, ...): re-offer every APPROVED / ISSUING batch. Cheap and
// idempotent, because each candidate's job has a fixed id.
export async function sweepIssuance(): Promise<number> {
  const batches = await prisma.batch.findMany({
    where: { status: { in: ["APPROVED", "ISSUING"] } },
    select: { id: true },
  });
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

// ============ The background consumers ============
// Starts the background consumers. Used by worker.ts (the worker container) and by the
// tests. Run as many copies as you like: BullMQ hands each job to exactly one worker,
// and a job whose worker dies is picked up again by another.
export function startWorkers(deps: { whatsapp: WhatsAppClient }, opts: { schedule?: boolean } = {}) {
  const prefix = config.queuePrefix;
  const make = <T>(name: string, processor: (job: Job<T>) => Promise<unknown>, extra: object = {}) =>
    new Worker<T>(name, processor, { connection: createBullConnection(), prefix, ...extra });

  // 1) the event that starts issuance
  const events = make<{ batchId: string; correlationId?: string }>(QUEUE_EVENTS, async (job) => {
    if (job.name === "batch.approved") await fanOutIssuance(job.data.batchId, job.data.correlationId);
  });

  // 2) one job per candidate. `limiter` caps how fast we call the WhatsApp provider.
  const issuance = make<{ candidateId: string; correlationId?: string }>(
    QUEUE_ISSUANCE,
    (job) => processIssue(job.data.candidateId, deps, job.data.correlationId),
    { concurrency: config.workerConcurrency, limiter: { max: config.whatsappRatePerSec, duration: 1000 } },
  );
  issuance.on("failed", (job, err) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (exhausted) {
      logger.error({ candidateId: job.data.candidateId, err: err.message }, "delivery gave up after all retries");
      void (async () => {
        const marked = await markDeliveryFailed(job.data.candidateId, err.message, job.data.correlationId);
        // No certificate exists, so there is nothing to mark FAILED. Remove the dead job so its id is
        // free again and the next sweep offers this candidate once more (otherwise it would be stuck).
        if (!marked) await job.remove();
      })().catch((e: Error) => logger.error({ err: e.message }, "could not record the failed delivery"));
    }
  });

  // 3) periodic housekeeping
  const maintenance = make(QUEUE_MAINTENANCE, async (job) => {
    if (job.name === "sweep") await sweepIssuance();
    if (job.name === "overdue-scan") {
      const flagged = await scanOverdue();
      if (flagged > 0) logger.warn({ flagged }, "batches flagged overdue");
    }
  });

  for (const w of [events, issuance, maintenance])
    w.on("error", (err) => logger.error({ err: err.message }, "worker error"));

  if (opts.schedule !== false) {
    // upsert = safe when many worker containers start: still ONE schedule, run by one of them.
    // The overdue-scan interval is a database setting (read when a worker starts).
    const q = getQueues().maintenance;
    void (async () => {
      const seconds = Math.max(
        MIN_OVERDUE_SCAN_SECONDS,
        await getSetting<number>("escalation.scanIntervalSeconds", DEFAULT_OVERDUE_SCAN_SECONDS),
      );
      await q.upsertJobScheduler("sweep", { every: SWEEP_EVERY_MS }, { name: "sweep" });
      await q.upsertJobScheduler("overdue-scan", { every: seconds * 1000 }, { name: "overdue-scan" });
      logger.info({ overdueScanEverySeconds: seconds }, "maintenance schedules set");
    })().catch((err) => logger.error({ err }, "could not set maintenance schedules"));
  }

  return {
    async close() {
      await Promise.all([events.close(), issuance.close(), maintenance.close()]);
    },
  };
}
