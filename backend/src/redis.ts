import { Queue } from "bullmq";
import Redis from "ioredis";

import { config, logger } from "./config";

// Everything that talks to Redis lives here, in four sections:
//   1. the shared client   2. rate limiting   3. job queues (BullMQ)   4. live updates (pub/sub)

// ============ 1. The shared client ============
const MAX_RETRIES_PER_REQUEST = 2; // fail fast instead of making a user wait on a dead Redis
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST });

// ============ 2. Rate limiting ============
// Fixed-window counter in Redis, shared by all API instances. Used on the public verify
// endpoint so nobody can hammer it to guess codes. Fails OPEN if Redis is unavailable:
// better a verify page that works than one that is down because a cache restarted.
export async function allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSeconds);
    return n <= limit;
  } catch (err) {
    logger.warn({ err }, "rate limiter unavailable; allowing request");
    return true;
  }
}

// Forget a counter, e.g. when someone finally signs in correctly: their earlier typos
// must not count towards locking them out.
export async function reset(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err }, "rate limiter unavailable; could not reset");
  }
}

// ============ 3. Job queues ============
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
export const createBullConnection = () => new Redis(config.redisUrl, { maxRetriesPerRequest: null });

let shared: { connection: Redis; events: Queue; issuance: Queue; maintenance: Queue } | null = null;

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
    {
      jobId: `approved-${batchId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
    },
  );
}

// ============ 4. Live updates ============
// "Something changed" notifications for the browser (live updates without refresh).
// Redis pub/sub fans them out to EVERY api instance, each of which pushes to its own
// connected browsers over SSE. Events are tiny hints (ids only, no personal data): the
// browser reacts by re-fetching what it is allowed to see through the normal,
// permission-checked endpoints. Pub/sub is fire-and-forget; that is fine for a hint, and
// anything important (issuing certificates) goes through the durable queue instead.
const CHANNEL = `${config.queuePrefix}:live`;

export interface LiveEvent {
  type: string; // e.g. batch.updated, batch.overdue, certificate.updated
  batchId?: string;
  certificateId?: string;
}

export async function publishLive(event: LiveEvent): Promise<void> {
  try {
    await redis.publish(CHANNEL, JSON.stringify({ ...event, at: new Date().toISOString() }));
  } catch (err) {
    logger.warn({ err }, "could not publish live event"); // never fail a request over a UI hint
  }
}

type Listener = (payload: string) => void;
const listeners = new Set<Listener>();
let subscriber: ReturnType<typeof redis.duplicate> | null = null;

// One Redis subscription per process, shared by all browsers connected to it.
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  if (!subscriber) {
    subscriber = redis.duplicate();
    subscriber.on("message", (_channel, payload) => listeners.forEach((l) => l(payload)));
    subscriber.subscribe(CHANNEL).catch((err) => logger.error({ err }, "live subscribe failed"));
  }
  return () => {
    listeners.delete(listener);
  };
}

export function closeLive() {
  subscriber?.disconnect();
  subscriber = null;
  listeners.clear();
}
