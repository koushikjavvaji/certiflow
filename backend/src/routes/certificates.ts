import { readFile } from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../audit";
import { prisma } from "../db";
import { conflict, HttpError, notFound } from "../errors";
import { retryDelivery } from "../issuance";
import { publishLive } from "../live";
import { authenticate, requireRole } from "../middleware/authenticate";
import { config } from "../config";
import { ensurePdf, isValidDownloadSignature } from "../pdf";
import { allow } from "../rate-limit";

export const certificatesRouter = Router();

// First letter of each word, the rest hidden: "Anika Sharma" -> "A**** S*****".
const maskName = (name: string) => name.split(/\s+/).map((w) => w.charAt(0) + "*".repeat(Math.max(1, w.length - 1))).join(" ");

// ---- PUBLIC: anyone can check a certificate (no login) ----------------------------
// Looked up by the unguessable verification code printed on the PDF / in its QR code, so
// strangers cannot walk through certificate numbers. Reads the database every time (no
// cache) on purpose: a cancelled certificate must NEVER be reported as genuine, not even
// for a few seconds. Shows only what an employer needs; never phone number or marks.
certificatesRouter.get("/verify/:code", async (req, res) => {
  const ip = req.ip ?? "unknown";
  if (!(await allow(`${config.queuePrefix}:rl:verify:${ip}`, config.verifyRateLimitPerMin, 60))) {
    res.status(429).json({ error: "too many lookups, please slow down" });
    return;
  }
  res.setHeader("cache-control", "no-store");
  const code = req.params.code.toUpperCase().replace(/[^0-9A-F]/g, ""); // allow dashes and spaces
  if (!/^[0-9A-F]{16}$/.test(code)) {
    res.status(404).json({ found: false });
    return;
  }
  const cert = await prisma.certificate.findUnique({
    where: { verifyCode: code },
    include: { candidate: { select: { name: true } }, batch: { select: { courseName: true, centre: { select: { name: true } } } } },
  });
  if (!cert) {
    res.status(404).json({ found: false });
    return;
  }
  res.json({
    found: true,
    status: cert.status, // VALID or CANCELLED
    number: cert.number,
    holder: maskName(cert.candidate.name),
    course: cert.batch.courseName,
    centre: cert.batch.centre.name,
    issuedAt: cert.createdAt,
    cancelledAt: cert.cancelledAt,
  });
});

// ---- PUBLIC but unguessable: the candidate's download link from WhatsApp ----------
certificatesRouter.get("/d/:id/:sig", async (req, res) => {
  const parsed = z.object({ id: z.uuid(), sig: z.string().length(32) }).safeParse(req.params);
  if (!parsed.success || !isValidDownloadSignature(parsed.data.id, parsed.data.sig)) throw notFound();
  const cert = await prisma.certificate.findUnique({ where: { id: parsed.data.id } });
  if (!cert) throw notFound();
  if (cert.status === "CANCELLED") throw new HttpError(410, "this certificate has been cancelled");
  const pdf = await readFile(await ensurePdf(cert.id));
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("content-type", "application/pdf");
  res.setHeader("content-disposition", `attachment; filename="${cert.number}.pdf"`);
  res.send(pdf);
});

// ---- STATE OFFICE -----------------------------------------------------------------
const reason = z.object({ reason: z.string().trim().min(3, "give a reason of at least 3 characters").max(500) });

certificatesRouter.post("/certificates/:id/cancel", authenticate, requireRole("STATE"), async (req, res) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const { reason: why } = reason.parse(req.body);
  const user = req.user!;
  const batchId = await prisma.$transaction(async (tx) => {
    const cert = await tx.certificate.findUnique({ where: { id } });
    if (!cert) throw notFound("certificate not found");
    // Conditional update: cancelling twice is refused, and the change is visible to the
    // very next verify request (verify never caches).
    const { count } = await tx.certificate.updateMany({
      where: { id, status: "VALID" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: why, cancelledById: user.id, updatedById: user.id },
    });
    if (count === 0) throw conflict("this certificate is already cancelled");
    await writeAudit(tx, { actor: user, action: "CERTIFICATE_CANCELLED", entityType: "Certificate", entityId: id, batchId: cert.batchId, reason: why, correlationId: String(req.id) });
    return cert.batchId;
  });
  await publishLive({ type: "certificate.updated", batchId, certificateId: id });
  res.json({ ok: true });
});

certificatesRouter.post("/certificates/:id/retry", authenticate, requireRole("STATE"), async (req, res) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  if (!(await retryDelivery(id, String(req.id)))) throw conflict("only a delivery that failed can be retried");
  res.json({ ok: true });
});
