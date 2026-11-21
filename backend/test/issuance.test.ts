import { afterAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../src/db";
import { fanOutIssuance, markDeliveryFailed, processIssue } from "../src/issuance";
import { sweepIssuance } from "../src/maintenance";
import { closeQueues } from "../src/queues";
import { startWorkers } from "../src/workers";
import { api, approveFully, auditFor, batchRow, createStubWhatsApp, makeBatch, makeSubmittedBatch, U, waitFor } from "./flow-helpers";

// The worker runs IN this process against the real queue (BullMQ on Redis), with a
// WhatsApp stand-in that fails, times out and "delivers but loses the reply".
const stub = createStubWhatsApp({ seed: 42, flaky: true });
let workers = startWorkers({ whatsapp: stub.client }, { schedule: false });

afterAll(async () => {
  await workers.close();
  await closeQueues();
});

const certs = (batchId: string) => rawPrisma.certificate.findMany({ where: { batchId } });
const completed = (batchId: string) => async () => (await batchRow(batchId)).status === "COMPLETED" && true;

describe("MOMENT 3: a batch of 60 is approved and WhatsApp is unreliable", () => {
  it("every candidate ends up with exactly one certificate and one message", async () => {
    const id = await makeSubmittedBatch(60);
    await approveFully(id, true); // 60 >= 50, so the quality team reviews too
    await waitFor(completed(id));

    const all = await certs(id);
    expect(all).toHaveLength(60);
    expect(new Set(all.map((c) => c.candidateId)).size).toBe(60); // one per candidate
    expect(new Set(all.map((c) => c.number)).size).toBe(60); // no shared numbers
    expect(all.every((c) => /^PSM-\d{4}-\d{6}$/.test(c.number))).toBe(true);
    expect(all.every((c) => c.deliveryStatus === "SENT")).toBe(true);

    // On the "phones": exactly one message per candidate, despite retries.
    const candidates = await rawPrisma.candidate.findMany({ where: { batchId: id } });
    const perPhone = stub.perPhone();
    for (const c of candidates) expect(perPhone.get(c.phone)).toBe(1);

    // The provider really was unreliable, and retries were needed.
    expect(stub.stats.failedCalls).toBeGreaterThan(0);
    expect(await rawPrisma.deliveryAttempt.count({ where: { ok: false, certificate: { batchId: id } } })).toBeGreaterThan(0);

    // The whole story is on record.
    const actions = (await auditFor(id)).map((a) => a.action);
    expect(actions.filter((a) => a === "CERTIFICATE_ISSUED")).toHaveLength(60);
    expect(actions.filter((a) => a === "CERTIFICATE_DELIVERED")).toHaveLength(60);
    expect(actions).toEqual(expect.arrayContaining(["BATCH_APPROVED", "ISSUANCE_STARTED", "BATCH_COMPLETED"]));
  });

  it("the approving request's trace id follows the batch into the worker's records", async () => {
    const id = await makeSubmittedBatch(4);
    const trace = `trace-e2e-${Date.now()}`;
    const dev = await api(U.dev);
    const meera = await api(U.meera);
    const farah = await api(U.farah);
    await dev.post(`/batches/${id}/decision`, { decision: "APPROVE" });
    await meera.post(`/batches/${id}/decision`, { decision: "APPROVE" });
    await farah.post(`/batches/${id}/decision`, { decision: "APPROVE" }, { "x-request-id": trace });
    await waitFor(completed(id));
    const issued = (await auditFor(id)).filter((a) => a.action === "CERTIFICATE_ISSUED");
    expect(issued.length).toBe(4);
    expect(issued.every((a) => a.correlationId === trace)).toBe(true); // API request -> event -> job -> audit row
  });

  it("the approve click returns before any certificate exists (slow work is not in the request)", async () => {
    const id = await makeSubmittedBatch(10);
    const dev = await api(U.dev);
    await dev.post(`/batches/${id}/decision`, { decision: "APPROVE" });
    await (await api(U.meera)).post(`/batches/${id}/decision`, { decision: "APPROVE" });
    const res = await (await api(U.farah)).post(`/batches/${id}/decision`, { decision: "APPROVE" });
    expect(res.status).toBe(200);
    expect(["APPROVED", "ISSUING", "COMPLETED"]).toContain((await batchRow(id)).status);
    await waitFor(completed(id));
  });
});

describe("the system stays correct when an instance restarts at any moment", () => {
  it("stopping the worker mid-batch and starting a new one finishes the job with no duplicates", async () => {
    const id = await makeSubmittedBatch(12);
    await approveFully(id);
    await waitFor(async () => (await rawPrisma.certificate.count({ where: { batchId: id, deliveryStatus: "SENT" } })) >= 3);

    await workers.close(); // "the instance restarts"
    workers = startWorkers({ whatsapp: stub.client }, { schedule: false });
    await waitFor(completed(id));

    expect(await certs(id)).toHaveLength(12);
    const candidates = await rawPrisma.candidate.findMany({ where: { batchId: id } });
    for (const c of candidates) expect(stub.perPhone().get(c.phone)).toBe(1);
  });

  it("if the approval event is lost (e.g. Redis restarted), the periodic sweep still issues the certificates", async () => {
    const id = await makeSubmittedBatch(5);
    await rawPrisma.batch.update({ where: { id }, data: { status: "APPROVED", currentStepKey: null } }); // approved, but NO event was queued
    await sweepIssuance();
    await waitFor(completed(id));
    expect(await certs(id)).toHaveLength(5);
  });

  it("running the same job many times at once still makes one certificate and sends one message", async () => {
    const id = await makeBatch(1);
    await rawPrisma.batch.update({ where: { id }, data: { status: "ISSUING" } });
    const candidate = await rawPrisma.candidate.findFirstOrThrow({ where: { batchId: id } });
    const calm = createStubWhatsApp(); // reliable, so every call succeeds and any duplicate would show
    await Promise.all(Array.from({ length: 8 }, () => processIssue(candidate.id, { whatsapp: calm.client })));
    expect(await certs(id)).toHaveLength(1);
    expect(calm.messages.size).toBe(1);
    await fanOutIssuance(id); // and offering the work again is harmless
    await waitFor(completed(id));
    expect(await certs(id)).toHaveLength(1);
  });
});

describe("NEVER: two certificates for one candidate, or two sharing a number", () => {
  it("the database refuses both", async () => {
    const id = await makeBatch(2);
    const [c1, c2] = await rawPrisma.candidate.findMany({ where: { batchId: id } });
    const base = { batchId: id, verifyCode: "A".repeat(16) };
    await rawPrisma.certificate.create({ data: { ...base, candidateId: c1!.id, number: "PSM-TEST-000001", verifyCode: "B".repeat(16) } });
    // same candidate again
    await expect(rawPrisma.certificate.create({ data: { ...base, candidateId: c1!.id, number: "PSM-TEST-000002", verifyCode: "C".repeat(16) } })).rejects.toThrow();
    // different candidate, same number
    await expect(rawPrisma.certificate.create({ data: { ...base, candidateId: c2!.id, number: "PSM-TEST-000001", verifyCode: "D".repeat(16) } })).rejects.toThrow();
  });

  it("numbers come from a sequence, so concurrent issuing across batches never repeats one", async () => {
    const batches = await Promise.all([makeBatch(5), makeBatch(5), makeBatch(5)]);
    const calm = createStubWhatsApp();
    for (const b of batches) await rawPrisma.batch.update({ where: { id: b }, data: { status: "ISSUING" } });
    const candidates = await rawPrisma.candidate.findMany({ where: { batchId: { in: batches } } });
    await Promise.all(candidates.map((c) => processIssue(c.id, { whatsapp: calm.client })));
    const numbers = (await rawPrisma.certificate.findMany({ where: { batchId: { in: batches } } })).map((c) => c.number);
    expect(numbers).toHaveLength(15);
    expect(new Set(numbers).size).toBe(15);
  });
});

describe("a WhatsApp outage: give up cleanly, then the state office retries", () => {
  it("failed deliveries are marked FAILED, the batch still completes, and a retry delivers", async () => {
    const id = await makeBatch(3);
    await rawPrisma.batch.update({ where: { id }, data: { status: "ISSUING" } });
    const down = createStubWhatsApp();
    down.setDown(true);
    const candidates = await rawPrisma.candidate.findMany({ where: { batchId: id } });
    for (const c of candidates) {
      await processIssue(c.id, { whatsapp: down.client }).catch(() => undefined); // a failed attempt
      await markDeliveryFailed(c.id, "provider down"); // the queue gave up
    }
    expect((await certs(id)).every((c) => c.deliveryStatus === "FAILED")).toBe(true);
    expect((await batchRow(id)).status).toBe("COMPLETED");
    expect((await auditFor(id)).filter((a) => a.action === "DELIVERY_FAILED")).toHaveLength(3);
    expect(down.messages.size).toBe(0);

    const target = (await certs(id))[0]!;
    expect((await (await api(U.dev)).post(`/certificates/${target.id}/retry`)).status).toBe(403); // not the state office
    expect((await (await api(U.farah)).post(`/certificates/${target.id}/retry`)).status).toBe(200);
    await waitFor(async () => (await rawPrisma.certificate.findUniqueOrThrow({ where: { id: target.id } })).deliveryStatus === "SENT");
    expect((await (await api(U.farah)).post(`/certificates/${target.id}/retry`)).status).toBe(409); // already delivered
  });
});
