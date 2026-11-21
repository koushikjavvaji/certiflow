process.env.SERVICE_NAME = "worker";

import { config, logger } from "./config";
import { disconnectDb, prisma } from "./db";
import { createHttpWhatsApp } from "./issuance";
import { closeQueues, redis } from "./redis";
import { startWorkers } from "./workers";

// The background process: starts the queue consumers (issuance, events, housekeeping).
// Slow or flaky work (PDFs, WhatsApp) happens here, never inside a user's request.
async function main() {
  await prisma.$queryRaw`SELECT 1`;
  await redis.ping();
  const workers = startWorkers({ whatsapp: createHttpWhatsApp() });
  logger.info({ concurrency: config.workerConcurrency }, "worker ready");

  const heartbeat = setInterval(() => logger.debug("worker alive"), 60_000);

  async function shutdown(signal: string) {
    logger.info({ signal }, "worker shutting down");
    clearInterval(heartbeat);
    await workers.close(); // finish the jobs in hand first
    await closeQueues();
    await disconnectDb();
    redis.disconnect();
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// An error nobody handled leaves the process in an unknown state: say what happened, then exit and
// let the restart policy bring up a clean one.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled rejection");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  process.exit(1);
});

main().catch((err) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
