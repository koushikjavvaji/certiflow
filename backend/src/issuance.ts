import { randomBytes } from "node:crypto";
import { writeAudit } from "./audit";
import { prisma } from "./db";
import { publishLive } from "./live";
import { logger } from "./logger";
import { downloadUrl, ensurePdf } from "./pdf";
import { getQueues, issueJobOptions } from "./queues";
import type { WhatsAppClient } from "./whatsapp";

// Turning an approved batch into certificates on phones.
//
// Every step below is IDEMPOTENT: running it twice (a retry, a duplicate event, two
// workers at once, a crash half-way) never makes a second certificate or a second message.
//   - one certificate per candidate: UNIQUE(candidateId) in the database
//   - unique numbers: a database sequence
//   - one WhatsApp message per certificate: the provider de-duplicates on the
//     idempotency key (the certificate id), even if our call timed out
//   - the PDF is only generated if its file is missing

const ISSUABLE = ["APPROVED", "ISSUING", "COMPLETED"] as const; // COMPLETED: state office retried a failed one

// event "batch.approved"  ->  one "issue" job per candidate that still needs work.
// Safe to call repeatedly (the periodic sweep does): jobs have a fixed id per candidate.
export async function fanOutIssuance(batchId: string, correlationId?: string): Promise<number> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch || !["APPROVED", "ISSUING"].includes(batch.status)) return 0;

  if (batch.status === "APPROVED") {
    const { count } = await prisma.batch.updateMany({ where: { id: batchId, status: "APPROVED" }, data: { status: "ISSUING" } });
    if (count > 0) {
      await writeAudit(prisma, { actor: null, action: "ISSUANCE_STARTED", entityType: "Batch", entityId: batchId, batchId, correlationId });
      await publishLive({ type: "batch.updated", batchId });
    }
  }

  // Candidates with no certificate yet, or one still waiting to be delivered.
  const todo = await prisma.candidate.findMany({
    where: { batchId, OR: [{ certificate: null }, { certificate: { deliveryStatus: "PENDING", status: "VALID" } }] },
    select: { id: true },
  });
  if (todo.length > 0) {
    await getQueues().issuance.addBulk(
      todo.map((c) => ({ name: "issue", data: { candidateId: c.id, correlationId }, opts: { jobId: `issue-${c.id}`, ...issueJobOptions() } })),
    );
  } else {
    await maybeComplete(batchId);
  }
  return todo.length;
}

const newVerifyCode = () => randomBytes(8).toString("hex").toUpperCase(); // 16 hex chars, 64 random bits

async function createCertificate(candidateId: string, batchId: string, correlationId?: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('certificate_number_seq') AS n`;
      const seq = rows[0]?.n;
      if (seq === undefined) throw new Error("could not get a certificate number");
      const number = `PSM-${new Date().getFullYear()}-${String(seq).padStart(6, "0")}`;
      const cert = await tx.certificate.create({ data: { candidateId, batchId, number, verifyCode: newVerifyCode() } });
      await writeAudit(tx, { actor: null, action: "CERTIFICATE_ISSUED", entityType: "Certificate", entityId: cert.id, batchId, metadata: { number }, correlationId });
      return cert;
    });
  } catch (err) {
    // Lost a race with another worker handling the same candidate: use theirs.
    const existing = await prisma.certificate.findUnique({ where: { candidateId } });
    if (existing) return existing;
    throw err;
  }
}

export async function processIssue(
  candidateId: string,
  deps: { whatsapp: WhatsAppClient },
  correlationId?: string,
): Promise<void> {
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId }, include: { batch: true } });
  if (!candidate || !(ISSUABLE as readonly string[]).includes(candidate.batch.status)) return;

  const cert = (await prisma.certificate.findUnique({ where: { candidateId } })) ?? (await createCertificate(candidateId, candidate.batchId, correlationId));
  if (cert.status === "CANCELLED") return; // a cancelled certificate is never sent
  if (cert.deliveryStatus === "SENT") return void (await maybeComplete(candidate.batchId));

  await ensurePdf(cert.id);

  const attemptNo = (await prisma.deliveryAttempt.count({ where: { certificateId: cert.id } })) + 1;
  try {
    await deps.whatsapp.send({
      to: candidate.phone,
      text: `Congratulations ${candidate.name}! Your ${candidate.batch.courseName} certificate (${cert.number}) is ready: ${downloadUrl(cert.id)}`,
      idempotencyKey: cert.id,
    });
  } catch (err) {
    await prisma.deliveryAttempt.create({ data: { certificateId: cert.id, attemptNo, ok: false, error: String((err as Error).message).slice(0, 300) } });
    logger.warn({ certificateId: cert.id, attemptNo, correlationId, err: (err as Error).message }, "whatsapp send failed; will retry");
    throw err; // the queue retries with backoff
  }

  await prisma.$transaction(async (tx) => {
    await tx.deliveryAttempt.create({ data: { certificateId: cert.id, attemptNo, ok: true } });
    await tx.certificate.updateMany({ where: { id: cert.id, deliveryStatus: { not: "SENT" } }, data: { deliveryStatus: "SENT", deliveredAt: new Date() } });
    await writeAudit(tx, { actor: null, action: "CERTIFICATE_DELIVERED", entityType: "Certificate", entityId: cert.id, batchId: candidate.batchId, metadata: { attempts: attemptNo }, correlationId });
  });
  await publishLive({ type: "certificate.updated", batchId: candidate.batchId, certificateId: cert.id });
  await maybeComplete(candidate.batchId);
}

// Called when the queue has given up on a candidate (all retries used).
export async function markDeliveryFailed(candidateId: string, error: string, correlationId?: string) {
  const cert = await prisma.certificate.findUnique({ where: { candidateId } });
  if (!cert) return;
  const { count } = await prisma.certificate.updateMany({ where: { id: cert.id, deliveryStatus: "PENDING" }, data: { deliveryStatus: "FAILED" } });
  if (count > 0) {
    await writeAudit(prisma, { actor: null, action: "DELIVERY_FAILED", entityType: "Certificate", entityId: cert.id, batchId: cert.batchId, reason: error.slice(0, 300), correlationId });
    await publishLive({ type: "certificate.updated", batchId: cert.batchId, certificateId: cert.id });
  }
  await maybeComplete(cert.batchId);
}

// The batch is COMPLETED once every candidate has a certificate and none is still pending.
async function maybeComplete(batchId: string) {
  const [pending, candidates, certificates] = await Promise.all([
    prisma.certificate.count({ where: { batchId, deliveryStatus: "PENDING", status: "VALID" } }),
    prisma.candidate.count({ where: { batchId } }),
    prisma.certificate.count({ where: { batchId } }),
  ]);
  if (pending > 0 || certificates < candidates) return;
  const { count } = await prisma.batch.updateMany({ where: { id: batchId, status: "ISSUING" }, data: { status: "COMPLETED" } });
  if (count > 0) {
    const failed = await prisma.certificate.count({ where: { batchId, deliveryStatus: "FAILED" } });
    await writeAudit(prisma, { actor: null, action: "BATCH_COMPLETED", entityType: "Batch", entityId: batchId, batchId, metadata: { certificates, deliveryFailed: failed } });
    await publishLive({ type: "batch.updated", batchId });
  }
}

// State office: try a failed delivery again.
export async function retryDelivery(certificateId: string, correlationId?: string) {
  const cert = await prisma.certificate.findUnique({ where: { id: certificateId } });
  if (!cert) return false;
  const { count } = await prisma.certificate.updateMany({ where: { id: cert.id, deliveryStatus: "FAILED", status: "VALID" }, data: { deliveryStatus: "PENDING" } });
  if (count === 0) return false;
  await getQueues().issuance.add("issue", { candidateId: cert.candidateId, correlationId }, { jobId: `issue-${cert.candidateId}-retry-${Date.now()}`, ...issueJobOptions() });
  await publishLive({ type: "certificate.updated", batchId: cert.batchId, certificateId: cert.id });
  return true;
}
