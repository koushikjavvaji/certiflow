import { Router } from "express";

import { authenticate } from "../auth";
import { getActiveWorkflow, getAllSettings } from "../config-store";
import { prisma } from "../db";
import { redis, subscribeLive } from "../redis";

// Small "about the system itself" endpoints: is it healthy, what are the live rules, and
// the stream that pushes live updates to the browser.
const HEARTBEAT_MS = 25_000; // keeps proxies from closing an idle stream

export const systemRouter = Router();

// Used by Docker health checks and (later) load balancers. 503 if a dependency is down.
systemRouter.get("/health", async (_req, res) => {
  const checks = { database: false, redis: false };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {
    /* reported below */
  }
  try {
    checks.redis = (await redis.ping()) === "PONG";
  } catch {
    /* reported below */
  }
  const ok = checks.database && checks.redis;
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", checks });
});

// Read-only view of the live rules (settings + approval path). Any logged-in user may look;
// changing them is done in the database.
systemRouter.get("/config", authenticate, async (_req, res) => {
  const [settings, workflow] = await Promise.all([getAllSettings(), getActiveWorkflow()]);
  res.json({ settings, workflow });
});

// Server-Sent Events: one long-lived response per browser. Messages carry only ids (see
// live.ts); the browser re-fetches through permission-checked endpoints.
systemRouter.get("/events", authenticate, (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no", // tell nginx not to buffer this stream
  });
  res.write(": connected\n\n");
  const unsubscribe = subscribeLive((payload) => res.write(`data: ${payload}\n\n`));
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
