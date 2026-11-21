import { createApp } from "./app";
import { config } from "./config";
import { disconnectDb } from "./db";
import { logger } from "./logger";
import { redis } from "./redis";

const app = createApp();
const server = app.listen(config.port, () => logger.info({ port: config.port }, "api listening"));

// The API keeps no state in memory, so it can be killed and restarted at any moment.
// On SIGTERM we stop accepting requests, finish in-flight ones, then close connections.
function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await disconnectDb();
    redis.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
