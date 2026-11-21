import { randomBytes } from "node:crypto";
import type { Batch, Candidate, Certificate } from "@prisma/client";
import { Handler, chainOf } from "./chain";
import { prisma, writeAudit } from "./db";
import { getQueues, issueJobOptions, publishLive } from "./redis";
import { config, logger } from "./config";
import { downloadUrl, ensurePdf } from "./pdf";

// Turning an approved batch into certificates on phones.
//
// Every step below is IDEMPOTENT: running it twice (a retry, a duplicate event, two
// workers at once, a crash half-way) never makes a second certificate or a second message.
//   - one certificate per candidate: UNIQUE(candidateId) in the database
//   - unique numbers: a database sequence
//   - one WhatsApp message per certificate: the provider de-duplicates on the
//     idempotency key (the certificate id), even if our call timed out
//   - the PDF is only generated if its file is missing

// ============ The WhatsApp provider (the fake one in development) ============
export interface WhatsAppMessage {
  to: string; // E.164 phone number
  text: string;
  // The provider de-duplicates on this key, so if we retry after a timeout where the
  // message was actually delivered, the candidate still gets exactly ONE message.
  idempotencyKey: string;
}

export interface WhatsAppClient {
  send(message: WhatsAppMessage): Promise<void>; // throws on any failure or timeout
}

// Talks to the (fake) provider over HTTP. Any non-2xx response, network error or
// timeout throws, and the queue retries the job later.
export function createHttpWhatsApp(baseUrl = config.whatsappUrl, timeoutMs = 5000): WhatsAppClient {
  return {
    async send(message) {
      const res = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": message.idempotencyKey },
        body: JSON.stringify({ to: message.to, text: message.text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`whatsapp responded ${res.status}`);
    },
  };
}

// ============ Issuing certificates ============
const ISSUABLE = ["APPROVED", "ISSUING", "COMPLETED"] as const; // COMPLETED: state office retried a failed one

// event "batch.approved"  ->  one "issue" job per candidate that still needs work.
// Safe to call repeatedly (the periodic sweep does): jobs have a fixed id per candidate.
export async function fanOutIssuance(batchId: string, correlationId?: string): Promise<number> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch || !["APPROVED", "ISSUING"].includes(batch.status)) return 0;

  if (batch.status === "APPROVED") {
    const { count } = await prisma.batch.updateMany({
      where: { id: batchId, status: "APPROVED" },
      data: { status: "ISSUING" },
    });
    if (count > 0) {
      await writeAudit(prisma, {
        actor: null,
        action: "ISSUANCE_STARTED",
        entityType: "Batch",
        entityId: batchId,
        batchId,
        correlationId,
      });
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
      todo.map((c) => ({
        name: "issue",
        data: { candidateId: c.id, correlationId },
        opts: { jobId: `issue-${c.id}`, ...issueJobOptions() },
      })),
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
      await writeAudit(tx, {
        actor: null,
        action: "CERTIFICATE_ISSUED",
        entityType: "Certificate",
        entityId: cert.id,
        batchId,
        metadata: { number },
        correlationId,
      });
      return cert;
    });
  } catch (err) {
    // Lost a race with another worker handling the same candidate: use theirs.
    const existing = await prisma.certificate.findUnique({ where: { candidateId } });
    if (existing) return existing;
    throw err;
  }
}

// ============ Making ONE certificate: a chain of small, repeatable steps ============
// Load → certificate → (cancelled? stop) → (already sent? stop) → PDF → WhatsApp → mark delivered
// → complete the batch. Every handler can safely run again, so a retry or a crash half-way
// simply picks the chain up again and the finished steps do nothing.
interface IssueContext {
  candidateId: string;
  whatsapp: WhatsAppClient;
  correlationId?: string;
  candidate?: Candidate & { batch: Batch };
  cert?: Certificate;
  attemptNo?: number;
}
type IssueHandler = Handler<IssueContext>;
const candidateOf = (c: IssueContext) => c.candidate as Candidate & { batch: Batch };
const certOf = (c: IssueContext) => c.cert as Certificate;

// 1. Find the candidate. Nothing to do if they are gone or the batch is not (yet) approved.
class LoadCandidate extends Handler<IssueContext> {
  protected async process(c: IssueContext) {
    const candidate = await prisma.candidate.findUnique({ where: { id: c.candidateId }, include: { batch: true } });
    if (!candidate || !(ISSUABLE as readonly string[]).includes(candidate.batch.status)) return true; // stop
    c.candidate = candidate;
    return false;
  }
}

// 2. The candidate's certificate: reuse it if it exists, otherwise create it (once, ever).
class EnsureCertificate extends Handler<IssueContext> {
  protected async process(c: IssueContext) {
    const candidate = candidateOf(c);
    c.cert =
      (await prisma.certificate.findUnique({ where: { candidateId: c.candidateId } })) ??
      (await createCertificate(c.candidateId, candidate.batchId, c.correlationId));
    return false;
  }
}

// 3. A cancelled certificate is never sent.
class StopIfCancelled extends Handler<IssueContext> {
  protected process(c: IssueContext) {
    return certOf(c).status === "CANCELLED";
  }
}

// 4. Already delivered (a retry, or a duplicate job)? Nothing more to send; just make sure the batch is closed out.
class StopIfAlreadySent extends Handler<IssueContext> {
  protected async process(c: IssueContext) {
    if (certOf(c).deliveryStatus !== "SENT") return false;
    await maybeComplete(candidateOf(c).batchId);
    return true;
  }
}

// 5. The PDF file (made only if it is missing).
class MakePdf extends Handler<IssueContext> {
  protected async process(c: IssueContext) {
    await ensurePdf(certOf(c).id);
    return false;
  }
}

// 6. Send the WhatsApp message. A failure is recorded and thrown, so the queue retries the whole chain later.
class SendWhatsApp extends Handler<IssueContext> {
  protected async process(c: IssueContext) {
    const candidate = candidateOf(c);
    const cert = certOf(c);
    c.attemptNo = (await prisma.deliveryAttempt.count({ where: { certificateId: cert.id } })) + 1;
    try {
      await c.whatsapp.send({
        to: candidate.phone,
        text: `Congratulations ${candidate.name}! Your ${candidate.batch.courseName} certificate (${cert.number}) is ready: ${downloadUrl(cert.id)}`,
        idempotencyKey: cert.id, // the provider de-duplicates on this, so a retry never sends twice
      });
    } catch (err) {
      await prisma.deliveryAttempt.create({
        data: {
          certificateId: cert.id,
          attemptNo: c.attemptNo,
          ok: false,
          error: String((err as Error).message).slice(0, 300),
        },
      });
      logger.warn(
        { certificateId: cert.id, attemptNo: c.attemptNo, correlationId: c.correlationId, err: (err as Error).message },
        "whatsapp send failed; will retry",
      );
      throw err;
    }
    return false;
  }
}

// 7. Record the success.
class MarkDelivered extends Handler<IssueContext> {
  protected async process(c: IssueContext) {
    const cert = certOf(c);
    const batchId = candidateOf(c).batchId;
    await prisma.$transaction(async (tx) => {
      await tx.deliveryAttempt.create({ data: { certificateId: cert.id, attemptNo: c.attemptNo as number, ok: true } });
      await tx.certificate.updateMany({
        where: { id: cert.id, deliveryStatus: { not: "SENT" } },
        data: { deliveryStatus: "SENT", deliveredAt: new Date() },
      });
      await writeAudit(tx, {
        actor: null,
        action: "CERTIFICATE_DELIVERED",
        entityType: "Certificate",
        entityId: cert.id,
        batchId,
        metadata: { attempts: c.attemptNo },
        correlationId: c.correlationId,
      });
    });
    await publishLive({ type: "certificate.updated", batchId, certificateId: cert.id });
    return false;
  }
}

// 8. If that was the last one, the whole batch is complete.
class CompleteBatchIfDone extends Handler<IssueContext> {
  protected async process(c: IssueContext) {
    await maybeComplete(candidateOf(c).batchId);
    return true;
  }
}

const issueChain: IssueHandler = chainOf<IssueContext>(
  new LoadCandidate(),
  new EnsureCertificate(),
  new StopIfCancelled(),
  new StopIfAlreadySent(),
  new MakePdf(),
  new SendWhatsApp(),
  new MarkDelivered(),
  new CompleteBatchIfDone(),
);

export async function processIssue(
  candidateId: string,
  deps: { whatsapp: WhatsAppClient },
  correlationId?: string,
): Promise<void> {
  await issueChain.handle({ candidateId, whatsapp: deps.whatsapp, correlationId });
}

// Called when the queue has given up on a candidate (all retries used).
export async function markDeliveryFailed(candidateId: string, error: string, correlationId?: string) {
  const cert = await prisma.certificate.findUnique({ where: { candidateId } });
  if (!cert) return;
  const { count } = await prisma.certificate.updateMany({
    where: { id: cert.id, deliveryStatus: "PENDING" },
    data: { deliveryStatus: "FAILED" },
  });
  if (count > 0) {
    await writeAudit(prisma, {
      actor: null,
      action: "DELIVERY_FAILED",
      entityType: "Certificate",
      entityId: cert.id,
      batchId: cert.batchId,
      reason: error.slice(0, 300),
      correlationId,
    });
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
  const { count } = await prisma.batch.updateMany({
    where: { id: batchId, status: "ISSUING" },
    data: { status: "COMPLETED" },
  });
  if (count > 0) {
    const failed = await prisma.certificate.count({ where: { batchId, deliveryStatus: "FAILED" } });
    await writeAudit(prisma, {
      actor: null,
      action: "BATCH_COMPLETED",
      entityType: "Batch",
      entityId: batchId,
      batchId,
      metadata: { certificates, deliveryFailed: failed },
    });
    await publishLive({ type: "batch.updated", batchId });
  }
}

// State office: try a failed delivery again.
export async function retryDelivery(certificateId: string, correlationId?: string) {
  const cert = await prisma.certificate.findUnique({ where: { id: certificateId } });
  if (!cert) return false;
  const { count } = await prisma.certificate.updateMany({
    where: { id: cert.id, deliveryStatus: "FAILED", status: "VALID" },
    data: { deliveryStatus: "PENDING" },
  });
  if (count === 0) return false;
  await getQueues().issuance.add(
    "issue",
    { candidateId: cert.candidateId, correlationId },
    { jobId: `issue-${cert.candidateId}-retry-${Date.now()}`, ...issueJobOptions() },
  );
  await publishLive({ type: "certificate.updated", batchId: cert.batchId, certificateId: cert.id });
  return true;
}
