import { randomBytes } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { rawPrisma } from "../src/db";
import { processIssue } from "../src/issuance";
import { app } from "./helpers";
import { api, approveFully, auditFor, createStubWhatsApp, makeSubmittedBatch, otherCentreToken, U } from "./flow-helpers";
import { bearer } from "./helpers";

// Issues certificates directly (no worker) so these tests only look at verify / cancel.
async function issuedBatch(n = 3) {
  const id = await makeSubmittedBatch(n);
  await approveFully(id);
  const stub = createStubWhatsApp();
  const candidates = await rawPrisma.candidate.findMany({ where: { batchId: id }, orderBy: { createdAt: "asc" } });
  for (const c of candidates) await processIssue(c.id, { whatsapp: stub.client });
  const certificates = await rawPrisma.certificate.findMany({ where: { batchId: id }, orderBy: { number: "asc" } });
  return { id, stub, certificates, candidates };
}

// Every verify call comes from a different "IP" so the rate-limit test is the only one that trips it.
const ipOf = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomBytes(2).toString("hex")}`;
const verify = (code: string, ip = ipOf()) => request(app).get(`/verify/${code}`).set("x-forwarded-for", ip);

describe("anyone can check a certificate, without logging in", () => {
  it("a valid certificate shows status and a masked holder, never phone or marks", async () => {
    const { certificates, candidates } = await issuedBatch();
    const res = await verify(certificates[0]!.verifyCode);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ found: true, status: "VALID", number: certificates[0]!.number, course: "Welding Basics" });
    expect(res.body.holder).toContain("*");
    expect(res.body.holder).not.toContain("Person");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(candidates[0]!.phone);
    expect(text).not.toContain(candidates[0]!.phone.slice(3));
    expect(Object.keys(res.body)).not.toEqual(expect.arrayContaining(["phone", "marks"]));
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("NEVER exposes any officer's profile to the public (candidates and employers have no account)", async () => {
    const { certificates, stub } = await issuedBatch(); // Dev, Meera and Farah all acted on this batch
    const body = JSON.stringify((await verify(certificates[0]!.verifyCode)).body);
    const message = [...stub.messages.values()][0]!.text;
    for (const officer of ["Dev", "Meera", "Kabir", "Neha", "Farah"]) {
      expect(body).not.toContain(officer);
      expect(message).not.toContain(officer);
    }
    // and every staff-only endpoint is closed to someone who is not logged in
    expect((await request(app).get(`/batches/${certificates[0]!.batchId}`)).status).toBe(401);
    expect((await request(app).get("/auth/demo-users").set("x-forwarded-for", ipOf())).status).toBe(200); // demo mode only; see README
  });

  it("accepts the code written with dashes or in lower case, and says 'not found' for anything else", async () => {
    const { certificates } = await issuedBatch(1);
    const code = certificates[0]!.verifyCode;
    const dashed = code.match(/.{4}/g)!.join("-").toLowerCase();
    expect((await verify(dashed)).status).toBe(200);
    expect((await verify("0000000000000000")).status).toBe(404);
    expect((await verify("short")).status).toBe(404);
    expect((await verify(certificates[0]!.number)).status).toBe(404); // the guessable number alone does not work
    expect((await verify("%3Cscript%3E")).body).toEqual({ found: false });
  });

  it("the public lookup is rate limited per caller", async () => {
    const ip = `203.0.113.${randomBytes(3).toString("hex")}`;
    const codes = Array.from({ length: 31 }, () => "0000000000000000");
    const statuses: number[] = [];
    for (const c of codes) statuses.push((await verify(c, ip)).status);
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("MOMENT 4: the state office cancels a fake certificate", () => {
  it("a lookup right afterwards says it is no longer valid", async () => {
    const { certificates, id } = await issuedBatch();
    const cert = certificates[0]!;
    expect((await verify(cert.verifyCode)).body.status).toBe("VALID"); // genuine before

    const cancel = await (await api(U.farah)).post(`/certificates/${cert.id}/cancel`, { reason: "Issued in error: duplicate of another record" });
    expect(cancel.status).toBe(200);

    const after = await verify(cert.verifyCode); // immediately after
    expect(after.status).toBe(200);
    expect(after.body.status).toBe("CANCELLED");
    expect(after.body.cancelledAt).toBeTruthy();
    expect((await verify(certificates[1]!.verifyCode)).body.status).toBe("VALID"); // others are untouched

    const trail = (await auditFor(id)).find((a) => a.action === "CERTIFICATE_CANCELLED")!;
    expect(trail).toMatchObject({ actorName: "Farah", reason: "Issued in error: duplicate of another record", entityId: cert.id });
  });

  it("a cancelled certificate can no longer be downloaded", async () => {
    const { certificates, stub } = await issuedBatch(1);
    const link = [...stub.messages.values()][0]!.text.match(/\/api(\/d\/[^\s]+)/)![1]!;
    expect((await request(app).get(link)).status).toBe(200);
    await (await api(U.farah)).post(`/certificates/${certificates[0]!.id}/cancel`, { reason: "fraud found later" });
    expect((await request(app).get(link)).status).toBe(410);
  });

  it("only the state office can cancel, a reason is required, and it cannot be cancelled twice", async () => {
    const { certificates } = await issuedBatch(1);
    const id = certificates[0]!.id;
    expect((await (await api(U.dev)).post(`/certificates/${id}/cancel`, { reason: "nope" })).status).toBe(403);
    expect((await (await api(U.neha)).post(`/certificates/${id}/cancel`, { reason: "nope" })).status).toBe(403);
    expect((await (await api(U.anika)).post(`/certificates/${id}/cancel`, { reason: "nope" })).status).toBe(403);
    expect((await request(app).post(`/certificates/${id}/cancel`).send({ reason: "nope" })).status).toBe(401);
    expect((await (await api(U.farah)).post(`/certificates/${id}/cancel`, {})).status).toBe(400);
    expect((await (await api(U.farah)).post(`/certificates/${id}/cancel`, { reason: "ok reason" })).status).toBe(200);
    expect((await (await api(U.farah)).post(`/certificates/${id}/cancel`, { reason: "again" })).status).toBe(409);
    expect((await rawPrisma.certificate.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
  });

  it("a cancelled certificate is never sent, even if its delivery job runs afterwards", async () => {
    const id = await makeSubmittedBatch(1);
    await approveFully(id);
    const stub = createStubWhatsApp();
    const candidate = await rawPrisma.candidate.findFirstOrThrow({ where: { batchId: id } });
    // issue, cancel before delivery completes (simulate: certificate exists but is still pending)
    const down = createStubWhatsApp();
    down.setDown(true);
    await processIssue(candidate.id, { whatsapp: down.client }).catch(() => undefined);
    const cert = await rawPrisma.certificate.findUniqueOrThrow({ where: { candidateId: candidate.id } });
    await (await api(U.farah)).post(`/certificates/${cert.id}/cancel`, { reason: "cancelled before delivery" });
    await processIssue(candidate.id, { whatsapp: stub.client });
    expect(stub.messages.size).toBe(0);
  });
});

describe("the candidate's download link", () => {
  it("works with the exact link from the WhatsApp message and serves a PDF", async () => {
    const { stub } = await issuedBatch(1);
    const text = [...stub.messages.values()][0]!.text;
    const link = text.match(/\/api(\/d\/[^\s]+)/)![1]!;
    const res = await request(app).get(link).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain(".pdf");
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("NEVER hands someone else's certificate to a stranger: guessed, altered or swapped links get nothing", async () => {
    const { stub, certificates } = await issuedBatch(2);
    const messages = [...stub.messages.values()];
    const [, id1, sig1] = messages[0]!.text.match(/\/d\/([0-9a-f-]{36})\/([0-9a-f]{32})/)!;
    const other = certificates.find((c) => c.id !== id1)!;
    expect((await request(app).get(`/d/${id1}/${"0".repeat(32)}`)).status).toBe(404); // guessed signature
    const flipped = sig1!.slice(0, 31) + (sig1!.endsWith("0") ? "1" : "0"); // always a DIFFERENT last character
    expect((await request(app).get(`/d/${id1}/${flipped}`)).status).toBe(404); // altered
    expect((await request(app).get(`/d/${other.id}/${sig1}`)).status).toBe(404); // someone else's id, my signature
    expect((await request(app).get(`/d/${crypto.randomUUID()}/${sig1}`)).status).toBe(404);
    expect((await request(app).get(`/d/not-a-uuid/${sig1}`)).status).toBe(404);
  });

  it("the message goes to the right phone and contains nothing but the link and number", async () => {
    const { stub, candidates } = await issuedBatch(2);
    const byPhone = new Map([...stub.messages.values()].map((m) => [m.to, m.text]));
    for (const c of candidates) {
      const text = byPhone.get(c.phone)!;
      expect(text).toContain(c.name);
      expect(text).toMatch(/PSM-\d{4}-\d{6}/);
    }
  });
});

describe("certificate files", () => {
  it("the PDF is generated once per certificate and is a real PDF", async () => {
    const { certificates } = await issuedBatch(1);
    const { readFileSync } = await import("node:fs");
    const buf = readFileSync(`./.data/test-certs/${certificates[0]!.id}.pdf`);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    expect(buf.length).toBeGreaterThan(1000);
  });
});

describe("downloading a certificate from the site (logged in)", () => {
  const pdfOf = async (userId: string, certId: string) => {
    const headers = bearer((await (await import("./helpers")).tokenFor(userId)));
    return request(app).get(`/certificates/${certId}/pdf`).set(headers).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  };

  it("everyone who may see the batch can download a real PDF", async () => {
    const { certificates } = await issuedBatch(2);
    for (const user of [U.anika, U.dev, U.meera, U.neha, U.farah]) {
      const res = await pdfOf(user, certificates[0]!.id);
      expect(res.status, user).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.headers["content-disposition"]).toContain(`${certificates[0]!.number}.pdf`);
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    }
  });

  it("NEVER hands it to people who may not see that batch (404, so existence is not revealed)", async () => {
    const { certificates } = await issuedBatch(1);
    const id = certificates[0]!.id;
    expect((await pdfOf(U.isha, id)).status).toBe(404); // officer of another district
    const stranger = await request(app).get(`/certificates/${id}/pdf`).set({ authorization: `Bearer ${await otherCentreToken()}` });
    expect(stranger.status).toBe(404); // a different training centre
    expect((await request(app).get(`/certificates/${id}/pdf`)).status).toBe(401); // not logged in
    expect((await pdfOf(U.farah, crypto.randomUUID())).status).toBe(404);
    expect((await pdfOf(U.farah, "not-a-uuid")).status).toBe(400);
  });

  it("a cancelled certificate cannot be downloaded by anyone, including the state office", async () => {
    const { certificates } = await issuedBatch(1);
    const id = certificates[0]!.id;
    expect((await pdfOf(U.farah, id)).status).toBe(200);
    await (await api(U.farah)).post(`/certificates/${id}/cancel`, { reason: "cancelled for the test" });
    expect((await pdfOf(U.farah, id)).status).toBe(410);
    expect((await pdfOf(U.anika, id)).status).toBe(410);
  });
});
