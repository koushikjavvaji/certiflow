import { defineConfig } from "vitest/config";

// Tests run against the REAL Postgres and Redis from docker compose (not mocks), because
// the rules we must prove (unique constraints, row locks, soft delete, queues) live there.
//   docker compose up -d postgres redis   then   npm test
//
// They use their OWN database (certiflow_test, dropped and recreated each run) and their
// own Redis db + queue prefix, so they can never touch the demo data or be picked up by
// the worker container that is running alongside.
//
// One process, one shared Prisma engine for all files (isolate: false): spinning up and
// tearing down a native Prisma engine per file made earlier runs flaky.
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    pool: "forks",
    isolate: false,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: "postgresql://certiflow:certiflow@localhost:5432/certiflow_test",
      REDIS_URL: "redis://localhost:6379/1",
      JWT_SECRET: "test-secret-test-secret-test-secret-123456",
      DEMO_MODE: "true",
      LOG_LEVEL: "silent",
      QUEUE_PREFIX: "ctest",
      CERT_DIR: "./.data/test-certs",
      PUBLIC_BASE_URL: "http://localhost:8080",
      DELIVERY_ATTEMPTS: "12",
      RETRY_BASE_DELAY_MS: "10",
      WHATSAPP_RATE_PER_SEC: "1000",
      VERIFY_RATE_LIMIT_PER_MIN: "30",
    },
  },
});
