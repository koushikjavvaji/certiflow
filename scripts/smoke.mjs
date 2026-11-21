#!/usr/bin/env node
// End-to-end smoke test of the RUNNING system (docker compose up). Signs in as every role and plays them through
// the whole journey over HTTP: upload -> approvals -> certificates on "phones" -> verify
// -> cancel -> verify again. Usage:  node scripts/smoke.mjs [baseUrl]
// Needs Node 18+. Uses fresh random data each run, so it can be repeated.
import { randomBytes } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:8080") + "/api";
const WHATSAPP = process.env.WHATSAPP_URL ?? "http://localhost:4000";
const tokens = {};
let step = 0;
const say = (msg) => console.log(`${String(++step).padStart(2)}. ${msg}`);
const fail = (msg) => { console.error(`\n✘ ${msg}`); process.exit(1); };

async function call(method, path, { as, body, expect: want } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (want !== undefined && res.status !== want) fail(`${method} ${path} as ${as ?? "anonymous"}: expected ${want}, got ${res.status} ${JSON.stringify(json)}`);
  return { status: res.status, body: json };
}

// Real sign-in (email + password), so this works with DEMO_MODE on OR off.
// The seeded password is set by SEED_PASSWORD (see .env.example); override it here if you changed it.
const PASSWORD = process.env.SEED_PASSWORD ?? "Pragati#Demo2026";
const names = ["Anika", "Dev", "Meera", "Kabir", "Neha", "Farah", "Isha"];
for (const name of names) {
  const email = `${name.toLowerCase()}@pragati.example`;
  tokens[name] = (await call("POST", "/auth/login", { body: { email, password: PASSWORD }, expect: 200 })).body.token;
}
say(`signed in with email + password as ${names.join(", ")}`);
const wrong = await call("POST", "/auth/login", { body: { email: "farah@pragati.example", password: "wrong" }, expect: 401 });
say(`a wrong password is refused: "${wrong.body.error}"`);

const course = "SM" + randomBytes(3).toString("hex").toUpperCase();
const phones = Array.from({ length: 60 }, () => "9" + String(Math.floor(Math.random() * 9e8) + 1e8));
const goodCsv = ["name,phone,courseCode,marks", ...phones.map((p, i) => `Smoke Person ${i + 1},${p},${course},${60 + (i % 40)}`)].join("\n");

const { body: { id } } = await call("POST", "/batches", { as: "Anika", body: { courseName: "Smoke Test Welding" }, expect: 201 });
say(`Anika created batch ${id.slice(0, 8)}…`);

const bad = await call("PUT", `/batches/${id}/candidates`, { as: "Anika", body: { csv: goodCsv.replace(phones[2], "123") }, expect: 422 });
say(`bad spreadsheet rejected with ${bad.body.totalErrors} clear problem(s) (row ${bad.body.errors[0].row}: ${bad.body.errors[0].message}); nothing saved`);

await call("PUT", `/batches/${id}/candidates`, { as: "Anika", body: { csv: goodCsv }, expect: 200 });
await call("POST", `/batches/${id}/submit`, { as: "Anika", body: {}, expect: 200 });
say("fixed sheet saved (60 candidates) and submitted");

await call("POST", `/batches/${id}/decision`, { as: "Isha", body: { decision: "APPROVE" }, expect: 404 });
await call("POST", `/batches/${id}/decision`, { as: "Neha", body: { decision: "APPROVE" }, expect: 403 });
say("an officer from another district (Isha) and the quality team (Neha, too early) were refused");

const both = await Promise.all(["Dev", "Meera"].map((as) => call("POST", `/batches/${id}/decision`, { as, body: { decision: "APPROVE" } })));
if (both.some((r) => r.status !== 200)) fail("simultaneous district approvals failed");
say("Dev and Meera approved at the same moment: batch moved forward once");

await call("POST", `/batches/${id}/decision`, { as: "Farah", body: { decision: "APPROVE" }, expect: 403 });
await call("POST", `/batches/${id}/decision`, { as: "Neha", body: { decision: "APPROVE" }, expect: 200 });
say("60 candidates = a big batch: Farah could not skip ahead; Neha (quality) approved");
await call("POST", `/batches/${id}/decision`, { as: "Farah", body: { decision: "APPROVE" }, expect: 200 });
say("Farah gave the final approval; certificates are now being made in the background");

process.stdout.write("    waiting for WhatsApp delivery (the fake provider fails ~30% of the time; retries cover it)");
let detail;
for (let i = 0; i < 240; i++) {
  detail = (await call("GET", `/batches/${id}`, { as: "Farah", expect: 200 })).body;
  if (detail.batch.status === "COMPLETED") break;
  process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 1000));
}
console.log();
if (detail.batch.status !== "COMPLETED") fail(`batch did not complete (status ${detail.batch.status})`);
const certs = detail.certificates;
const retried = certs.filter((c) => c.attempts > 1).length;
say(`batch COMPLETED: ${certs.length} certificates, ${certs.filter((c) => c.deliveryStatus === "SENT").length} delivered, ${retried} needed retries`);
if (certs.length !== 60 || new Set(certs.map((c) => c.number)).size !== 60) fail("expected 60 certificates with unique numbers");

const onPhones = await (await fetch(`${WHATSAPP}/messages`)).json();
const mine = onPhones.sent.filter((m) => phones.some((p) => m.to === `+91${p}`));
const perPhone = new Map();
for (const m of mine) perPhone.set(m.to, (perPhone.get(m.to) ?? 0) + 1);
if (mine.length !== 60 || [...perPhone.values()].some((n) => n !== 1)) fail(`phones received ${mine.length} messages; expected exactly one each`);
say(`checked the fake phones: exactly one message each (${onPhones.attempts.failed} provider failures along the way)`);

const target = certs.find((c) => c.verifyCode);
const code = target.verifyCode.replaceAll("-", "");
const v1 = await call("GET", `/verify/${code}`, { expect: 200 });
say(`anyone can verify ${v1.body.number} without logging in: ${v1.body.status}, holder shown as "${v1.body.holder}"`);

await call("POST", `/certificates/${target.id}/cancel`, { as: "Dev", body: { reason: "should not work" }, expect: 403 });
await call("POST", `/certificates/${target.id}/cancel`, { as: "Farah", body: { reason: "Smoke test: issued in error" }, expect: 200 });
const v2 = await call("GET", `/verify/${code}`, { expect: 200 });
if (v2.body.status !== "CANCELLED") fail("a cancelled certificate still verifies as valid!");
say(`Farah cancelled it; the very next lookup says ${v2.body.status}`);

const trail = (await call("GET", `/batches/${id}`, { as: "Farah", expect: 200 })).body.audit;
say(`audit trail has ${trail.length} entries; first decision by ${trail.find((a) => a.action === "STEP_APPROVED").actor}`);
console.log("\n✔ smoke test passed");
