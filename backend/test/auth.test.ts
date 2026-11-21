import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { authenticate, requireRole } from "../src/auth";
import { DEMO_USER_IDS, app, bearer, tokenFor } from "./helpers";

const SECRET = "test-secret-test-secret-test-secret-123456";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("demo login and identity", () => {
  it("logs in as a demo person and /me reports who they are (role comes from the DB)", async () => {
    const token = await tokenFor(DEMO_USER_IDS.dev);
    const res = await request(app).get("/me").set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: "Dev", role: "DISTRICT_OFFICER" });
    expect(res.body.user.districtId).toBeTruthy();
  });

  it("the token carries only the user id, never a role", async () => {
    const claims = jwt.decode(await tokenFor(DEMO_USER_IDS.anika)) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual(["exp", "iat", "iss", "sub"]);
  });

  it("lists the demo people for the switcher", async () => {
    const res = await request(app).get("/auth/demo-users");
    const names = res.body.users.map((u: { name: string }) => u.name);
    expect(names).toEqual(expect.arrayContaining(["Anika", "Dev", "Meera", "Kabir", "Neha", "Farah"]));
  });

  it("rejects an unknown user and malformed input", async () => {
    expect((await request(app).post("/auth/demo-login").send({ userId: crypto.randomUUID() })).status).toBe(404);
    expect((await request(app).post("/auth/demo-login").send({ userId: "not-a-uuid" })).status).toBe(400);
    expect((await request(app).post("/auth/demo-login").send({})).status).toBe(400);
    const malformed = await request(app).post("/auth/demo-login").set("content-type", "application/json").send("{bad");
    expect(malformed.status).toBe(400);
  });

  it("rejects oversized request bodies instead of crashing", async () => {
    const res = await request(app)
      .post("/auth/demo-login")
      .send({ userId: "x".repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe("acting as someone else is impossible (tampered tokens)", () => {
  it("no token, junk token, wrong scheme -> 401", async () => {
    expect((await request(app).get("/me")).status).toBe(401);
    expect((await request(app).get("/me").set(bearer("junk"))).status).toBe(401);
    expect((await request(app).get("/me").set({ authorization: "Basic abc" })).status).toBe(401);
  });

  it("changing the user id inside a valid token breaks the signature -> 401", async () => {
    const [h, , s] = (await tokenFor(DEMO_USER_IDS.anika)).split(".");
    const payload = b64({ sub: DEMO_USER_IDS.farah, iss: "certiflow", iat: 1, exp: 9999999999 });
    expect(
      (
        await request(app)
          .get("/me")
          .set(bearer(`${h}.${payload}.${s}`))
      ).status,
    ).toBe(401);
  });

  it("a corrupted signature -> 401", async () => {
    const token = await tokenFor(DEMO_USER_IDS.anika);
    const tampered = token.slice(0, -3) + (token.endsWith("AAA") ? "BBB" : "AAA");
    expect((await request(app).get("/me").set(bearer(tampered))).status).toBe(401);
  });

  it("an 'alg: none' unsigned token -> 401", async () => {
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: DEMO_USER_IDS.farah, iss: "certiflow" })}.`;
    expect((await request(app).get("/me").set(bearer(unsigned))).status).toBe(401);
  });

  it("a token signed with a different secret -> 401", async () => {
    const foreign = jwt.sign({}, "some-other-secret-some-other-secret-1234", {
      subject: DEMO_USER_IDS.farah,
      issuer: "certiflow",
    });
    expect((await request(app).get("/me").set(bearer(foreign))).status).toBe(401);
  });

  it("an expired token -> 401", async () => {
    const expired = jwt.sign({}, SECRET, { subject: DEMO_USER_IDS.dev, issuer: "certiflow", expiresIn: -60 });
    expect((await request(app).get("/me").set(bearer(expired))).status).toBe(401);
  });

  it("a validly signed token for a user that does not exist -> 401", async () => {
    const ghost = jwt.sign({}, SECRET, { subject: crypto.randomUUID(), issuer: "certiflow", expiresIn: 60 });
    expect((await request(app).get("/me").set(bearer(ghost))).status).toBe(401);
  });

  it("a token with the wrong issuer -> 401", async () => {
    const wrong = jwt.sign({}, SECRET, { subject: DEMO_USER_IDS.dev, issuer: "someone-else", expiresIn: 60 });
    expect((await request(app).get("/me").set(bearer(wrong))).status).toBe(401);
  });
});

describe("role checks happen on the server", () => {
  const guarded = express();
  guarded.get("/state-only", authenticate, requireRole("STATE"), (_req, res) => res.json({ ok: true }));
  guarded.get("/officers", authenticate, requireRole("DISTRICT_OFFICER", "QUALITY"), (_req, res) =>
    res.json({ ok: true }),
  );

  it("allows the right role and forbids the others (403, not 401)", async () => {
    const farah = bearer(await tokenFor(DEMO_USER_IDS.farah));
    const anika = bearer(await tokenFor(DEMO_USER_IDS.anika));
    expect((await request(guarded).get("/state-only").set(farah)).status).toBe(200);
    expect((await request(guarded).get("/state-only").set(anika)).status).toBe(403);
    expect((await request(guarded).get("/officers").set(anika)).status).toBe(403);
    expect(
      (
        await request(guarded)
          .get("/officers")
          .set(bearer(await tokenFor(DEMO_USER_IDS.neha)))
      ).status,
    ).toBe(200);
  });

  it("anonymous callers get 401 before any role logic runs", async () => {
    expect((await request(guarded).get("/state-only")).status).toBe(401);
  });
});

describe("demo login only exists in demo mode", () => {
  it("with demoMode off the switch-user routes do not exist", async () => {
    const prodApp = createApp({ demoMode: false });
    expect((await request(prodApp).post("/auth/demo-login").send({ userId: DEMO_USER_IDS.farah })).status).toBe(404);
    expect((await request(prodApp).get("/auth/demo-users")).status).toBe(404);
  });
});
