import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { ZodError } from "zod";
import { logger } from "./logger";
import { authRouter } from "./routes/auth";
import { healthRouter } from "./routes/health";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // Request id = correlation id. Returned to the caller and attached to every log line.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
    }),
  );

  app.use(healthRouter);
  app.use(authRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid input", issues: err.issues });
      return;
    }
    // Malformed JSON body etc.
    if (typeof err === "object" && err !== null && "status" in err && err.status === 400) {
      res.status(400).json({ error: "bad request" });
      return;
    }
    req.log.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal error" }); // never leak internals
  };
  app.use(errorHandler);

  return app;
}
