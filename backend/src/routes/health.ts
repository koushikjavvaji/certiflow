import { Router } from "express";
import { prisma } from "../db";
import { redis } from "../redis";

export const healthRouter = Router();

// Used by Docker health checks and (later) load balancers. 503 if a dependency is down.
healthRouter.get("/health", async (_req, res) => {
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
