import { createApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { logger } from "./logger";
import { redis } from "./redis";

const app = createApp();
const server = app.listen(config.port, () => logger.info({ port: config.port }, "api listening"));

// The API keeps no state in memory, so it can be killed and restarted at any moment.
// On SIGTERM we stop accepting requests, finish in-flight ones, then close connections.
async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
