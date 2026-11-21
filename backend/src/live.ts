import { config } from "./config";
import { logger } from "./logger";
import { redis } from "./redis";

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
