import { randomBytes } from "node:crypto";

import request from "supertest";

import { createApp } from "../src/app";
import { signToken } from "../src/auth";
import { rawPrisma } from "../src/db";
import type { WhatsAppClient } from "../src/issuance";
import { DEMO_USER_IDS } from "../src/seed";

export const app = createApp({ demoMode: true });
export { DEMO_USER_IDS };

export async function tokenFor(userId: string): Promise<string> {
  const res = await request(app).post("/auth/demo-login").send({ userId });
  if (res.status !== 200) throw new Error(`demo-login failed: ${res.status}`);
  return res.body.token as string;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// ---------------- helpers for the certificate flow ----------------
export const U = DEMO_USER_IDS;

// Unique, valid Indian mobile numbers so tests never clash on "same person, same course".
let seq = 100_000_000 + Math.floor(Math.random() * 300_000_000);
export const nextPhone = () => `9${String(seq++).padStart(9, "0")}`;
export const randomCourse = () => `T${randomBytes(3).toString("hex").toUpperCase()}`;

export function csvOf(n: number, course = randomCourse()) {
  const lines = ["name,phone,courseCode,marks"];
  for (let i = 1; i <= n; i++) lines.push(`Test Person ${i},${nextPhone()},${course},${50 + (i % 50)}`);
  return lines.join("\n");
}

// A logged-in caller (as one of the demo people, or any user id).
export async function api(userId: string) {
  const headers = bearer(await tokenFor(userId));
  return {
    get: (path: string) => request(app).get(path).set(headers),
    post: (path: string, body: object = {}, extra: Record<string, string> = {}) =>
      request(app).post(path).set(headers).set(extra).send(body),
    put: (path: string, body: object = {}) => request(app).put(path).set(headers).send(body),
  };
}

export async function makeBatch(n: number, course?: string) {
  const anika = await api(U.anika);
  const created = await anika.post("/batches", { courseName: "Welding Basics" });
  if (created.status !== 201) throw new Error(`create failed ${created.status}`);
  const id = created.body.id as string;
  if (n > 0) {
    const up = await anika.put(`/batches/${id}/candidates`, { csv: csvOf(n, course) });
    if (up.status !== 200) throw new Error(`upload failed ${up.status} ${JSON.stringify(up.body)}`);
  }
  return id;
}

export async function makeSubmittedBatch(n: number, course?: string) {
  const id = await makeBatch(n, course);
  const sub = await (await api(U.anika)).post(`/batches/${id}/submit`);
  if (sub.status !== 200) throw new Error(`submit failed ${sub.status} ${JSON.stringify(sub.body)}`);
  return id;
}

export const decide = async (
  userId: string,
  batchId: string,
  decision: "APPROVE" | "SEND_BACK" | "REJECT",
  reason?: string,
) => (await api(userId)).post(`/batches/${batchId}/decision`, { decision, reason });

export async function approveOk(userId: string, batchId: string) {
  const res = await decide(userId, batchId, "APPROVE");
  if (res.status !== 200) throw new Error(`approve by ${userId} failed: ${res.status} ${JSON.stringify(res.body)}`);
}

// Walks a submitted batch through every step. big = 50+ candidates (needs quality review).
export async function approveFully(batchId: string, big = false) {
  await approveOk(U.dev, batchId);
  await approveOk(U.meera, batchId);
  if (big) await approveOk(U.neha, batchId);
  await approveOk(U.farah, batchId);
}

export const batchRow = (id: string) => rawPrisma.batch.findUniqueOrThrow({ where: { id } });
export const auditFor = (batchId: string) =>
  rawPrisma.auditLog.findMany({ where: { batchId }, orderBy: { createdAt: "asc" } });

// A user of a DIFFERENT centre (the seed has one centre user), to prove centres cannot see each other's data.
export async function otherCentreToken() {
  const id = "30000000-0000-4000-8000-0000000000aa";
  await rawPrisma.user.upsert({
    where: { id },
    update: { isActive: true },
    create: { id, name: "Other Centre", role: "CENTRE", centreId: "20000000-0000-4000-8000-000000000002" },
  });
  return signToken(id);
}

export async function waitFor<T>(check: () => Promise<T | false | undefined>, ms = 45_000, every = 100): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// Deterministic pseudo-random numbers, so a "flaky" provider fails the same way each run.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A WhatsApp stand-in that behaves like the real provider: fails, times out, and even
// "delivers but the reply is lost" (the case that tempts you to send twice). Like the real
// one it de-duplicates on the idempotency key. `messages` is what reached phones.
export function createStubWhatsApp(opts: { seed?: number; flaky?: boolean } = {}) {
  const rnd = mulberry32(opts.seed ?? 1);
  const messages = new Map<string, { to: string; text: string }>();
  const stats = { calls: 0, failedCalls: 0 };
  let down = false;
  const client: WhatsAppClient = {
    async send(m) {
      stats.calls++;
      const deliver = () => {
        if (!messages.has(m.idempotencyKey)) messages.set(m.idempotencyKey, { to: m.to, text: m.text });
      };
      if (down) {
        stats.failedCalls++;
        throw new Error("provider down");
      }
      if (opts.flaky) {
        const r = rnd();
        if (r < 0.2) {
          stats.failedCalls++;
          throw new Error("503 provider unavailable");
        }
        if (r < 0.35) {
          deliver(); // it WAS delivered, but we are told it failed
          stats.failedCalls++;
          throw new Error("timeout (message was actually delivered)");
        }
        if (r < 0.45) {
          stats.failedCalls++;
          throw new Error("429 rate limited");
        }
      }
      deliver();
    },
  };
  const perPhone = () => {
    const counts = new Map<string, number>();
    for (const m of messages.values()) counts.set(m.to, (counts.get(m.to) ?? 0) + 1);
    return counts;
  };
  return { client, messages, stats, perPhone, setDown: (v: boolean) => void (down = v) };
}
