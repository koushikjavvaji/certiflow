import { defineConfig } from "vitest/config";

// Tests run against the REAL Postgres and Redis from docker compose (not mocks), because
// the rules we must prove (unique constraints, soft delete, role checks) live there.
//   docker compose up -d postgres redis   then   npm test
//
// One process, one shared Prisma engine for all files (isolate: false). Spinning up and
// tearing down a native Prisma engine per file is what made earlier runs flaky.
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    pool: "forks",
    isolate: false,
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://certiflow:certiflow@localhost:5432/certiflow",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      JWT_SECRET: "test-secret-test-secret-test-secret-123456",
      DEMO_MODE: "true",
      LOG_LEVEL: "silent",
    },
  },
});
