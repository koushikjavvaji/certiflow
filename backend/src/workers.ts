import { Worker, type Job } from "bullmq";
import { config } from "./config";
import { getSetting } from "./config-store";
import { fanOutIssuance, markDeliveryFailed, processIssue } from "./issuance";
import { logger } from "./logger";
import { scanOverdue, sweepIssuance } from "./maintenance";
import { createBullConnection, getQueues, QUEUE_EVENTS, QUEUE_ISSUANCE, QUEUE_MAINTENANCE } from "./queues";
import type { WhatsAppClient } from "./whatsapp";

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
      void markDeliveryFailed(job.data.candidateId, err.message, job.data.correlationId);
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

  for (const w of [events, issuance, maintenance]) w.on("error", (err) => logger.error({ err: err.message }, "worker error"));

  if (opts.schedule !== false) {
    // upsert = safe when many worker containers start: still ONE schedule, run by one of them.
    // The overdue-scan interval is a database setting (read when a worker starts).
    const q = getQueues().maintenance;
    void (async () => {
      const seconds = Math.max(5, await getSetting<number>("escalation.scanIntervalSeconds", 15));
      await q.upsertJobScheduler("sweep", { every: 30_000 }, { name: "sweep" });
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
