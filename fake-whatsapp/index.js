// Stand-in for the WhatsApp provider (there is no real WhatsApp account in this project).
// Phase 1: a minimal, dependency-free server that accepts messages so the stack has
// something to talk to. Phase 4 makes it behave like the real thing: random failures,
// timeouts and slow responses, so the retry/idempotency logic can be proven.
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 4000);
const sent = []; // in-memory log of accepted messages (this is a fake; loss on restart is fine)

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { status: "ok" });

  if (req.method === "GET" && req.url === "/messages") return send(res, 200, { count: sent.length, sent });

  if (req.method === "POST" && req.url === "/messages") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) req.destroy(); // cap body size
    });
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return send(res, 400, { error: "invalid json" });
      }
      if (typeof body.to !== "string" || typeof body.text !== "string") {
        return send(res, 400, { error: "'to' and 'text' are required" });
      }
      const message = { id: randomUUID(), to: body.to, text: body.text, at: new Date().toISOString() };
      sent.push(message);
      if (sent.length > 1000) sent.shift();
      send(res, 202, { id: message.id, status: "accepted" });
    });
    return;
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(JSON.stringify({ service: "fake-whatsapp", msg: "listening", port: PORT })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
