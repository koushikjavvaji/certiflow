import { randomUUID } from "node:crypto";

import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { ZodError } from "zod";

import { HttpError } from "./chain";
import { config, logger } from "./config";
import { createAuthRouter } from "./routes/auth";
import { batchesRouter } from "./routes/batches";
import { certificatesRouter } from "./routes/certificates";
import { systemRouter } from "./routes/system";

export interface AppOptions {
  demoMode?: boolean;
}

export function createApp({ demoMode = config.demoMode }: AppOptions = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // exactly one proxy (nginx) in front: req.ip is the real caller
  app.use(helmet());
  // No CORS: the browser only talks to its own origin (nginx in Docker, the Vite
  // proxy in dev), which forwards /api to this server. Cross-origin calls are refused.
  app.use(express.json({ limit: "2mb" }));

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

  app.use(systemRouter);
  app.use(createAuthRouter(demoMode));
  app.use("/batches", batchesRouter);
  app.use(certificatesRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid input", issues: err.issues });
      return;
    }
    // Client errors raised by body parsing: malformed JSON (400), body too large (413)...
    const status = typeof err === "object" && err !== null && "status" in err ? Number(err.status) : 0;
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? "payload too large" : "bad request" });
      return;
    }
    req.log.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal error" }); // never leak internals
  };
  app.use(errorHandler);

  return app;
}
