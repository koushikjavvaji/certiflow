import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";

// Why BullMQ: it runs on the Redis we already need, gives durable jobs, automatic
// retries with backoff, per-job ids (de-duplication), rate limiting and repeatable
// jobs, so we do not add a second system (RabbitMQ/Kafka) for this scale.
//
// Three queues:
//   events       "batch.approved": the event that starts issuance (API -> worker)
//   issuance     one "issue" job per candidate (make certificate, PDF, send WhatsApp)
//   maintenance  repeating "sweep" and "overdue-scan" jobs
export const QUEUE_EVENTS = "events";
export const QUEUE_ISSUANCE = "issuance";
export const QUEUE_MAINTENANCE = "maintenance";

// BullMQ workers need a connection that never gives up on a command.
export const createBullConnection = () => new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

let shared: { connection: IORedis; events: Queue; issuance: Queue; maintenance: Queue } | null = null;

export function getQueues() {
  if (!shared) {
    const connection = createBullConnection();
    const opts = { connection, prefix: config.queuePrefix };
    shared = {
      connection,
      events: new Queue(QUEUE_EVENTS, opts),
      issuance: new Queue(QUEUE_ISSUANCE, opts),
      maintenance: new Queue(QUEUE_MAINTENANCE, opts),
    };
  }
  return shared;
}

export async function closeQueues() {
  if (!shared) return;
  const s = shared;
  shared = null;
  await Promise.all([s.events.close(), s.issuance.close(), s.maintenance.close()]);
  s.connection.disconnect();
}

// Every "issue" job is retried with exponential backoff, and finished jobs are kept for
// a while so duplicate adds with the same jobId are ignored.
export const issueJobOptions = () => ({
  attempts: config.deliveryAttempts,
  backoff: { type: "exponential" as const, delay: config.retryBaseDelayMs },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: false,
});

export async function enqueueBatchApproved(batchId: string, correlationId?: string) {
  await getQueues().events.add(
    "batch.approved",
    { batchId, correlationId },
    { jobId: `approved-${batchId}`, attempts: 5, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: true },
  );
}
