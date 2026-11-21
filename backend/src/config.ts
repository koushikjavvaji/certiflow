import pino from "pino";
import { z } from "zod";

// Every setting comes from the environment and is validated once at startup, so a
// misconfigured container fails immediately instead of misbehaving later.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  DEMO_MODE: z.enum(["true", "false"]).default("false"),
  WHATSAPP_URL: z.string().default("http://localhost:4000"),
  PORT: z.coerce.number().int().default(3000),
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  // --- queue / delivery ---
  QUEUE_PREFIX: z.string().default("certiflow"), // namespaces Redis keys (tests use their own)
  PUBLIC_BASE_URL: z.string().default("http://localhost:8080"), // used in QR codes and WhatsApp links
  CERT_DIR: z.string().default("./.data/certs"), // where generated PDFs are stored
  DELIVERY_ATTEMPTS: z.coerce.number().int().min(1).default(8), // tries per certificate before giving up
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).default(2000), // exponential backoff base
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  WHATSAPP_RATE_PER_SEC: z.coerce.number().int().min(1).default(20), // cap on provider calls per second
  VERIFY_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120), // public lookups per IP
  LOGIN_ATTEMPTS_PER_10_MIN: z.coerce.number().int().min(1).default(10), // per email address
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

const env = parsed.data;

export const config = {
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  jwtSecret: env.JWT_SECRET,
  demoMode: env.DEMO_MODE === "true",
  whatsappUrl: env.WHATSAPP_URL,
  port: env.PORT,
  isProduction: env.NODE_ENV === "production",
  logLevel: env.LOG_LEVEL,
  queuePrefix: env.QUEUE_PREFIX,
  publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
  certDir: env.CERT_DIR,
  deliveryAttempts: env.DELIVERY_ATTEMPTS,
  retryBaseDelayMs: env.RETRY_BASE_DELAY_MS,
  workerConcurrency: env.WORKER_CONCURRENCY,
  whatsappRatePerSec: env.WHATSAPP_RATE_PER_SEC,
  verifyRateLimitPerMin: env.VERIFY_RATE_LIMIT_PER_MIN,
  loginAttemptsPer10Min: env.LOGIN_ATTEMPTS_PER_10_MIN,
} as const;

// Structured JSON logs. Every HTTP request gets a request id (see app.ts) that is attached to its
// log lines, so one batch's story can be followed across the API and the worker.
export const logger = pino({ level: config.logLevel, base: { service: process.env.SERVICE_NAME ?? "api" } });

// A reminder, not a block (the demo runs on the default). Real use needs a real secret.
if (config.jwtSecret.startsWith("dev-only")) {
  logger.warn("JWT_SECRET is the well-known development value: set a real secret before any real use");
}
