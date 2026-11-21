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
} as const;
