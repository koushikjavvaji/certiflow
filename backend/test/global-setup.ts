import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

// Before any test: a brand-new database with migrations + seed applied, an empty Redis
// db, and an empty certificate folder. "Fresh clone -> npm test" needs only Postgres and
// Redis to be running.
const TEST_DB = "postgresql://certiflow:certiflow@localhost:5432/certiflow_test";
const ADMIN_DB = "postgresql://certiflow:certiflow@localhost:5432/postgres";
const TEST_REDIS = "redis://localhost:6379/1";

export default async function setup() {
  const admin = new PrismaClient({ datasourceUrl: process.env.TEST_ADMIN_DATABASE_URL ?? ADMIN_DB });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS certiflow_test WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE certiflow_test`);
  await admin.$disconnect();

  const env = {
    ...process.env,
    DATABASE_URL: TEST_DB,
    REDIS_URL: TEST_REDIS,
    JWT_SECRET: "test-secret-test-secret-test-secret-123456",
  };
  execSync("npx prisma migrate deploy", { stdio: "pipe", env });
  execSync("npx tsx src/seed.ts", { stdio: "pipe", env });

  const redis = new Redis(TEST_REDIS);
  await redis.flushdb();
  redis.disconnect();
  rmSync("./.data/test-certs", { recursive: true, force: true });
}
