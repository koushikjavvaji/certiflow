import { readFile } from "node:fs/promises";

import type { Certificate } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

import { authenticate, requireRole, type AuthUser } from "../auth";
import { Handler, HttpError, chainOf, conflict, notFound } from "../chain";
import { config } from "../config";
import { prisma, writeAudit } from "../db";
import { retryDelivery } from "../issuance";
import { ensurePdf, isValidDownloadSignature } from "../pdf";
import { allow, publishLive } from "../redis";
import { canView } from "../workflow";

export const certificatesRouter = Router();

// First letter of each word, the rest hidden: "Anika Sharma" -> "A**** S*****".
const maskName = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w.charAt(0) + "*".repeat(Math.max(1, w.length - 1)))
    .join(" ");

// ============ PUBLIC VERIFY as a chain ============
// Rate limit → clean up the code → find the certificate → describe it. Anyone can use it
// (no login). Looked up by the unguessable code printed on the PDF / in its QR, so strangers
// cannot walk through certificate numbers. It reads the database every time (no cache) on
// purpose: a cancelled certificate must NEVER look genuine, not even for a few seconds. It
// shows only what an employer needs, never a phone number or marks.
interface VerifyContext {
  ip: string;
  rawCode: string;
  code?: string;
  cert?: Certificate & { candidate: { name: string }; batch: { courseName: string; centre: { name: string } } };
  result: { status: number; body: object };
}

class LimitLookups extends Handler<VerifyContext> {
  protected async process(c: VerifyContext) {
    if (!(await allow(`${config.queuePrefix}:rl:verify:${c.ip}`, config.verifyRateLimitPerMin, 60)))
      throw new HttpError(429, "too many lookups, please slow down");
    return false;
  }
}

class CleanCode extends Handler<VerifyContext> {
  protected process(c: VerifyContext) {
    const code = c.rawCode.toUpperCase().replace(/[^0-9A-F]/g, ""); // allow dashes and spaces
    if (!/^[0-9A-F]{16}$/.test(code)) {
      c.result = { status: 404, body: { found: false } };
      return true; // not a code: stop, nothing to look up
    }
    c.code = code;
    return false;
  }
}

class FindCertificate extends Handler<VerifyContext> {
  protected async process(c: VerifyContext) {
    c.cert =
      (await prisma.certificate.findUnique({
        where: { verifyCode: c.code },
        include: {
          candidate: { select: { name: true } },
          batch: { select: { courseName: true, centre: { select: { name: true } } } },
        },
      })) ?? undefined;
    if (!c.cert) c.result = { status: 404, body: { found: false } };
    return !c.cert;
  }
}

class DescribeCertificate extends Handler<VerifyContext> {
  protected process(c: VerifyContext) {
    const cert = c.cert as NonNullable<VerifyContext["cert"]>;
    c.result = {
      status: 200,
      body: {
        found: true,
        status: cert.status, // VALID or CANCELLED
        number: cert.number,
        holder: maskName(cert.candidate.name),
        course: cert.batch.courseName,
        centre: cert.batch.centre.name,
        issuedAt: cert.createdAt,
        cancelledAt: cert.cancelledAt,
      },
    };
    return true;
  }
}

const verifyChain = chainOf<VerifyContext>(
  new LimitLookups(),
  new CleanCode(),
  new FindCertificate(),
  new DescribeCertificate(),
);

certificatesRouter.get("/verify/:code", async (req, res) => {
  const context: VerifyContext = {
    ip: req.ip ?? "unknown",
    rawCode: req.params.code,
    result: { status: 404, body: { found: false } },
  };
  res.setHeader("cache-control", "no-store");
  await verifyChain.handle(context);
  res.status(context.result.status).json(context.result.body);
});

// ============ DOWNLOADING a certificate: two entrances, one shared chain ============
// Candidate's link from WhatsApp:  check the signed link → find it → not cancelled → send the PDF
// Logged-in staff from the site:   find it → may they see this batch? → not cancelled → send the PDF
// A cancelled certificate is never served, to anyone.
interface DownloadContext {
  id: string;
  sig?: string; // the candidate's link signature (public entrance only)
  user?: AuthUser; // the signed-in person (staff entrance only)
  cert?: Certificate & { batch: { centreId: string; centre: { districtId: string } } };
  pdf?: Buffer;
}

// The link is "signed": a stranger cannot guess a valid one. Anything wrong looks like "not found".
class CheckLinkSignature extends Handler<DownloadContext> {
  protected process(c: DownloadContext) {
    const ok = z.object({ id: z.uuid(), sig: z.string().length(32) }).safeParse({ id: c.id, sig: c.sig });
    if (!ok.success || !isValidDownloadSignature(c.id, c.sig as string)) throw notFound();
    return false;
  }
}

class LoadCertificate extends Handler<DownloadContext> {
  protected async process(c: DownloadContext) {
    c.cert =
      (await prisma.certificate.findUnique({
        where: { id: c.id },
        include: { batch: { select: { centreId: true, centre: { select: { districtId: true } } } } },
      })) ?? undefined;
    if (!c.cert) throw notFound("certificate not found");
    return false;
  }
}

// Same permission as seeing the batch itself; anyone else gets "not found" (existence is not revealed).
class CheckCanSee extends Handler<DownloadContext> {
  protected process(c: DownloadContext) {
    if (!canView(c.user as AuthUser, (c.cert as NonNullable<DownloadContext["cert"]>).batch))
      throw notFound("certificate not found");
    return false;
  }
}

class NotCancelled extends Handler<DownloadContext> {
  protected process(c: DownloadContext) {
    if ((c.cert as NonNullable<DownloadContext["cert"]>).status === "CANCELLED")
      throw new HttpError(410, "this certificate has been cancelled");
    return false;
  }
}

class LoadPdf extends Handler<DownloadContext> {
  protected async process(c: DownloadContext) {
    c.pdf = await readFile(await ensurePdf(c.id));
    return true;
  }
}

const publicDownloadChain = chainOf<DownloadContext>(
  new CheckLinkSignature(),
  new LoadCertificate(),
  new NotCancelled(),
  new LoadPdf(),
);
const staffDownloadChain = chainOf<DownloadContext>(
  new LoadCertificate(),
  new CheckCanSee(),
  new NotCancelled(),
  new LoadPdf(),
);

function sendPdf(res: import("express").Response, c: DownloadContext) {
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("content-type", "application/pdf");
  res.setHeader(
    "content-disposition",
    `attachment; filename="${(c.cert as NonNullable<DownloadContext["cert"]>).number}.pdf"`,
  );
  res.send(c.pdf);
}

certificatesRouter.get("/d/:id/:sig", async (req, res) => {
  const context: DownloadContext = { id: req.params.id, sig: req.params.sig };
  await publicDownloadChain.handle(context);
  sendPdf(res, context);
});

certificatesRouter.get("/certificates/:id/pdf", authenticate, async (req, res) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const context: DownloadContext = { id, user: req.user };
  await staffDownloadChain.handle(context);
  sendPdf(res, context);
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
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: why,
        cancelledById: user.id,
        updatedById: user.id,
      },
    });
    if (count === 0) throw conflict("this certificate is already cancelled");
    await writeAudit(tx, {
      actor: user,
      action: "CERTIFICATE_CANCELLED",
      entityType: "Certificate",
      entityId: id,
      batchId: cert.batchId,
      reason: why,
      correlationId: String(req.id),
    });
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
