import { execSync } from "node:child_process";

// Brings the database to a known state before any test: apply migrations, load seed.
// Makes "fresh clone -> npm test" work with nothing but postgres + redis running.
export default function setup() {
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://certiflow:certiflow@localhost:5432/certiflow",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    JWT_SECRET: "test-secret-test-secret-test-secret-123456",
  };
  execSync("npx prisma migrate deploy", { stdio: "pipe", env });
  execSync("npx tsx src/seed.ts", { stdio: "pipe", env });
}
