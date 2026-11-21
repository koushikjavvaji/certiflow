import { createApp } from "./app";
import { config, logger } from "./config";
import { disconnectDb } from "./db";
import { closeLive, closeQueues, redis } from "./redis";

const app = createApp();
const server = app.listen(config.port, () => logger.info({ port: config.port }, "api listening"));

// The API keeps no state in memory, so it can be killed and restarted at any moment.
// On SIGTERM we stop accepting requests, finish in-flight ones, then close connections.
const GRACE_MS = 2_000; // how long in-flight requests get before long-lived streams are cut

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    closeLive();
    await closeQueues();
    await disconnectDb();
    redis.disconnect();
    process.exit(0);
  });
  server.closeIdleConnections();
  // The live-update streams never end by themselves: close them after a short grace period. The
  // browsers reconnect to another instance, so nobody notices.
  setTimeout(() => server.closeAllConnections(), GRACE_MS).unref();
  setTimeout(() => process.exit(1), 2 * GRACE_MS).unref(); // last resort
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

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
