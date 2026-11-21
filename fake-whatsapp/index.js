// Stand-in for the WhatsApp provider (there is no real WhatsApp account in this project).
// It behaves like the real thing, INCLUDING failing:
//   - ~12% answer 503 (provider down)         - ~5% answer 429 (rate limited)
//   - ~8%  never answer in time (timeout)     - ~5% DELIVER the message but drop the
//     connection before answering: the nastiest case, because the caller thinks it
//     failed and retries. Real providers de-duplicate on the Idempotency-Key header, and
//     so does this one: the same key is delivered at most once, however often it is sent.
// Rates and delays are tunable by environment variables so tests / demos can change them.
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 4000);
const rate = (name, dflt) => Number(process.env[name] ?? dflt);
const cfg = {
  error503: rate("FAKE_503_RATE", 0.12),
  error429: rate("FAKE_429_RATE", 0.05),
  timeout: rate("FAKE_TIMEOUT_RATE", 0.08),
  lostResponse: rate("FAKE_LOST_RESPONSE_RATE", 0.05),
  timeoutMs: rate("FAKE_TIMEOUT_MS", 15000), // longer than the caller's 5 s timeout
  mode: process.env.FAKE_MODE || "flaky", // flaky | reliable | down
};

const delivered = new Map(); // idempotency key -> message (this is the "phone")
const attemptsSeen = { total: 0, failed: 0 };

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req, cb) {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 64 * 1024) req.destroy();
  });
  req.on("end", () => {
    try {
      cb(null, JSON.parse(raw || "{}"));
    } catch {
      cb(new Error("invalid json"));
    }
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "GET" && url === "/health") return send(res, 200, { status: "ok", mode: cfg.mode });

  // What actually reached "phones" (for demos): newest first.
  if (req.method === "GET" && url === "/messages") {
    const sent = [...delivered.values()].reverse().slice(0, 200);
    return send(res, 200, { delivered: delivered.size, attempts: attemptsSeen, sent });
  }

  // Switch behaviour at runtime: PUT /mode {"mode":"down"|"reliable"|"flaky"}
  if (req.method === "PUT" && url === "/mode") {
    return readJson(req, (err, body) => {
      if (err || !["flaky", "reliable", "down"].includes(body.mode)) return send(res, 400, { error: "mode must be flaky, reliable or down" });
      cfg.mode = body.mode;
      send(res, 200, { mode: cfg.mode });
    });
  }

  if (req.method === "POST" && url === "/messages") {
    return readJson(req, (err, body) => {
      if (err) return send(res, 400, { error: "invalid json" });
      if (typeof body.to !== "string" || typeof body.text !== "string") return send(res, 400, { error: "'to' and 'text' are required" });
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 8) return send(res, 400, { error: "Idempotency-Key header is required" });

      attemptsSeen.total++;
      const fail = () => {
        attemptsSeen.failed++;
      };

      if (cfg.mode === "down") {
        fail();
        return send(res, 503, { error: "provider unavailable" });
      }
      if (cfg.mode === "flaky") {
        const roll = Math.random();
        if (roll < cfg.error503) {
          fail();
          return send(res, 503, { error: "provider unavailable" });
        }
        if (roll < cfg.error503 + cfg.error429) {
          fail();
          return send(res, 429, { error: "rate limited" });
        }
        if (roll < cfg.error503 + cfg.error429 + cfg.timeout) {
          fail();
          return void setTimeout(() => !res.writableEnded && send(res, 504, { error: "gateway timeout" }), cfg.timeoutMs);
        }
        if (roll < cfg.error503 + cfg.error429 + cfg.timeout + cfg.lostResponse) {
          // delivered, but the caller never hears about it
          if (!delivered.has(key)) delivered.set(key, { id: randomUUID(), key, to: body.to, text: body.text, at: new Date().toISOString() });
          fail();
          return req.socket.destroy();
        }
      }

      // Success. The same key is never delivered twice.
      let message = delivered.get(key);
      const duplicate = !!message;
      if (!message) {
        message = { id: randomUUID(), key, to: body.to, text: body.text, at: new Date().toISOString() };
        delivered.set(key, message);
        if (delivered.size > 5000) delivered.delete(delivered.keys().next().value);
      }
      send(res, duplicate ? 200 : 202, { id: message.id, status: duplicate ? "duplicate" : "accepted" });
    });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(JSON.stringify({ service: "fake-whatsapp", msg: "listening", port: PORT, mode: cfg.mode })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
