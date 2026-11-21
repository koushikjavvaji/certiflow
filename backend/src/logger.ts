import pino from "pino";
import { config } from "./config";

// Structured JSON logs. Every HTTP request gets a request id (see app.ts) that is
// attached to its log lines, so one batch's story can be followed across logs.
export const logger = pino({ level: config.logLevel, base: { service: process.env.SERVICE_NAME ?? "api" } });
