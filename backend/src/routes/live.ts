import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { subscribeLive } from "../live";

export const liveRouter = Router();

// Server-Sent Events: one long-lived response per browser. Messages carry only ids (see
// live.ts); the browser re-fetches through permission-checked endpoints.
liveRouter.get("/events", authenticate, (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no", // tell nginx not to buffer this stream
  });
  res.write(": connected\n\n");
  const unsubscribe = subscribeLive((payload) => res.write(`data: ${payload}\n\n`));
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000); // keeps proxies from closing it
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
