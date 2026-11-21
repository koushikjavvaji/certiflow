import request from "supertest";
import { describe, expect, it } from "vitest";

import { app } from "./helpers";

describe("health and request tracing", () => {
  it("/health reports database and redis", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { database: true, redis: true } });
  });

  it("every response carries a request id, and a safe caller-supplied one is kept", async () => {
    const generated = await request(app).get("/health");
    expect(generated.headers["x-request-id"]).toMatch(/^[\w-]{8,}$/);

    const kept = await request(app).get("/health").set("x-request-id", "trace-abc-12345");
    expect(kept.headers["x-request-id"]).toBe("trace-abc-12345");

    const unsafe = await request(app).get("/health").set("x-request-id", "bad id with spaces & <script>");
    expect(unsafe.headers["x-request-id"]).not.toContain("<script>");
  });

  it("sets security headers and hides the framework", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does not enable CORS (cross-origin browsers get no permission header)", async () => {
    const res = await request(app).get("/health").set("origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("unknown routes give a clean JSON 404", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });
});
