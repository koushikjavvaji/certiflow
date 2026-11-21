import { randomBytes } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { rawPrisma } from "../src/db";
import { hashPassword, verifyPassword } from "../src/password";
import { DEFAULT_SEED_PASSWORD, DEMO_EMAILS } from "../src/seed";
import { app, bearer, DEMO_USER_IDS } from "./helpers";

// Each call comes from its own "IP" so these tests never trip the per-IP limit by accident.
const login = (email: string, password: string, a = app) =>
  request(a).post("/auth/login").set("x-forwarded-for", `192.0.2.${Math.floor(Math.random() * 250) + 1}-${randomBytes(2).toString("hex")}`).send({ email, password });

describe("signing in with email and password", () => {
  it("the right email and password give a working session for that person", async () => {
    const res = await login(DEMO_EMAILS.farah, DEFAULT_SEED_PASSWORD);
    expect(res.status).toBe(200);
    const me = await request(app).get("/me").set(bearer(res.body.token));
    expect(me.body.user).toMatchObject({ id: DEMO_USER_IDS.farah, name: "Farah", role: "STATE" });
    expect((await request(app).get("/batches?view=stuck").set(bearer(res.body.token))).status).toBe(200); // state-only, so the role is real
  });

  it("ignores capital letters and stray spaces in the email", async () => {
    expect((await login("  Dev@Pragati.EXAMPLE ", DEFAULT_SEED_PASSWORD)).status).toBe(200);
  });

  it("every seeded person can sign in as themselves", async () => {
    for (const [key, email] of Object.entries(DEMO_EMAILS)) {
      const res = await login(email, DEFAULT_SEED_PASSWORD);
      expect(res.status, email).toBe(200);
      const me = await request(app).get("/me").set(bearer(res.body.token));
      expect(me.body.user.id).toBe(DEMO_USER_IDS[key as keyof typeof DEMO_USER_IDS]);
    }
  });

  it("a wrong password and an unknown email get the SAME answer (no hint which emails exist)", async () => {
    const wrong = await login(DEMO_EMAILS.anika, "not-the-password");
    const unknown = await login("nobody@pragati.example", "not-the-password");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toEqual({ error: "invalid email or password" });
    expect(wrong.body.token).toBeUndefined();
  });

  it("works the same when demo mode is OFF (and the no-password shortcut is gone)", async () => {
    const prodApp = createApp({ demoMode: false });
    expect((await login(DEMO_EMAILS.neha, DEFAULT_SEED_PASSWORD, prodApp)).status).toBe(200);
    expect((await request(prodApp).get("/auth/config")).body).toEqual({ demoMode: false });
    expect((await request(prodApp).post("/auth/demo-login").send({ userId: DEMO_USER_IDS.farah })).status).toBe(404);
    expect((await request(prodApp).get("/auth/demo-users")).status).toBe(404);
    expect((await request(app).get("/auth/config")).body).toEqual({ demoMode: true });
  });

  it("rejects malformed input", async () => {
    expect((await login("not-an-email", "x")).status).toBe(400);
    expect((await request(app).post("/auth/login").send({ email: DEMO_EMAILS.dev })).status).toBe(400);
    expect((await request(app).post("/auth/login").send({})).status).toBe(400);
    expect((await login(DEMO_EMAILS.dev, "")).status).toBe(400);
    expect((await login(DEMO_EMAILS.dev, "x".repeat(5000))).status).toBe(400);
  });

  it("a removed (soft-deleted) person can no longer sign in, and old tokens stop working", async () => {
    const id = crypto.randomUUID();
    const email = `temp-${randomBytes(4).toString("hex")}@pragati.example`;
    await rawPrisma.user.create({ data: { id, name: "Temp", email, role: "STATE", passwordHash: await hashPassword("Temp#Pass-12345") } });
    const ok = await login(email, "Temp#Pass-12345");
    expect(ok.status).toBe(200);
    expect((await request(app).get("/me").set(bearer(ok.body.token))).status).toBe(200);

    await rawPrisma.user.update({ where: { id }, data: { isActive: false } });
    expect((await login(email, "Temp#Pass-12345")).status).toBe(401);
    expect((await request(app).get("/me").set(bearer(ok.body.token))).status).toBe(401);
  });

  it("an account with no password set cannot be signed into", async () => {
    const email = `nopass-${randomBytes(4).toString("hex")}@pragati.example`;
    await rawPrisma.user.create({ data: { name: "No Password", email, role: "STATE" } });
    expect((await login(email, "")).status).toBe(400);
    expect((await login(email, "anything")).status).toBe(401);
  });
});

describe("NEVER: brute-forcing a password", () => {
  it("after too many tries for one email, even the right password is refused for a while", async () => {
    const email = `target-${randomBytes(4).toString("hex")}@pragati.example`;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await login(email, `guess-${i}`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("the limit follows the EMAIL, so guesses spread over many addresses do not get around it", async () => {
    const email = `spread-${randomBytes(4).toString("hex")}@pragati.example`;
    for (let i = 0; i < 10; i++) await login(email, `guess-${i}`); // each from a different IP
    expect((await login(email, DEFAULT_SEED_PASSWORD)).status).toBe(429);
  });

  it("successful sign-ins never count towards a lockout, and a correct sign-in wipes earlier typos", async () => {
    const email = `legit-${randomBytes(4).toString("hex")}@pragati.example`;
    const password = "Legit#Pass-98765";
    await rawPrisma.user.create({ data: { name: "Legit", email, role: "STATE", passwordHash: await hashPassword(password) } });
    for (let i = 0; i < 12; i++) expect((await login(email, password)).status).toBe(200); // 12 successes in a row
    for (let i = 0; i < 9; i++) expect((await login(email, `typo-${i}`)).status).toBe(401); // 9 typos...
    expect((await login(email, password)).status).toBe(200); // ...then the right password works
    for (let i = 0; i < 9; i++) expect((await login(email, `typo-${i}`)).status).toBe(401); // typos start from zero again
    expect((await login(email, password)).status).toBe(200);
  });

  it("many guesses fired in PARALLEL cannot slip past the limit", async () => {
    const email = `parallel-${randomBytes(4).toString("hex")}@pragati.example`;
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => login(email, `guess-${i}`)));
    const checked = results.filter((r) => r.status === 401).length; // guesses that were actually evaluated
    expect(checked).toBeLessThanOrEqual(10);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(15);
  });

  it("one caller hammering many different emails is limited too", async () => {
    const ip = `198.51.100.${randomBytes(3).toString("hex")}`;
    const send = () => request(app).post("/auth/login").set("x-forwarded-for", ip).send({ email: `x${randomBytes(4).toString("hex")}@pragati.example`, password: "pw" });
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await send()).status);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
  });
});

describe("NEVER: passwords stored or shown", () => {
  it("only a salted scrypt hash is stored, a different one for each person", async () => {
    const users = await rawPrisma.user.findMany({ where: { id: { in: Object.values(DEMO_USER_IDS) } }, select: { passwordHash: true } });
    expect(users).toHaveLength(7);
    for (const u of users) {
      expect(u.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);
      expect(u.passwordHash).not.toContain(DEFAULT_SEED_PASSWORD);
    }
    expect(new Set(users.map((u) => u.passwordHash)).size).toBe(7); // same password, different salt
  });

  it("no endpoint ever returns a password hash or an email", async () => {
    const token = (await login(DEMO_EMAILS.farah, DEFAULT_SEED_PASSWORD)).body.token;
    const bodies = [
      (await request(app).get("/me").set(bearer(token))).text,
      (await request(app).get("/auth/demo-users")).text,
      (await request(app).get("/auth/config")).text,
      (await request(app).get("/config").set(bearer(token))).text,
      (await request(app).get("/batches?view=all").set(bearer(token))).text,
    ];
    for (const text of bodies) {
      expect(text).not.toContain("scrypt");
      expect(text).not.toContain("passwordHash");
      expect(text).not.toContain("pragati.example");
    }
  });

  it("hashing is salted and verification is exact", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });
});

describe("one account per email", () => {
  it("the database refuses two active people with the same email (any capitalisation); a removed one frees it", async () => {
    const email = `dup-${randomBytes(4).toString("hex")}@pragati.example`;
    const first = await rawPrisma.user.create({ data: { name: "A", email, role: "STATE" } });
    await expect(rawPrisma.user.create({ data: { name: "B", email: email.toUpperCase(), role: "STATE" } })).rejects.toThrow();
    await rawPrisma.user.update({ where: { id: first.id }, data: { isActive: false } });
    await expect(rawPrisma.user.create({ data: { name: "C", email, role: "STATE" } })).resolves.toBeTruthy();
  });
});
