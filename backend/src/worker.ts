process.env.SERVICE_NAME = "worker";

import { prisma } from "./db";
import { logger } from "./logger";
import { redis } from "./redis";

// Phase 1: an empty shell that proves the worker container can reach Postgres and Redis.
// Phase 4 adds the BullMQ consumers (PDF generation, WhatsApp delivery) here.
async function main() {
  await prisma.$queryRaw`SELECT 1`;
  await redis.ping();
  logger.info("worker ready (no job consumers yet)");

  const heartbeat = setInterval(() => logger.debug("worker alive"), 60_000);

  async function shutdown(signal: string) {
    logger.info({ signal }, "worker shutting down");
    clearInterval(heartbeat);
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
