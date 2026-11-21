import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { config } from "./config";
import { prisma } from "./db";

export const verifyUrl = (code: string) => `${config.publicBaseUrl}/verify/${code}`;

// Download links are "signed": the signature is an HMAC of the certificate id with a
// server secret. Nothing needs storing, a stranger cannot guess a valid link, and the
// worker can rebuild the same link on every retry.
const signature = (certificateId: string) =>
  createHmac("sha256", config.jwtSecret).update(`download:${certificateId}`).digest("hex").slice(0, 32);

export const downloadUrl = (certificateId: string) =>
  `${config.publicBaseUrl}/api/d/${certificateId}/${signature(certificateId)}`;

export function isValidDownloadSignature(certificateId: string, sig: string): boolean {
  const a = Buffer.from(signature(certificateId));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 16 hex chars shown as XXXX-XXXX-XXXX-XXXX
export const formatCode = (code: string) => code.match(/.{4}/g)?.join("-") ?? code;

export interface CertificateFacts {
  number: string;
  verifyCode: string;
  holderName: string;
  courseName: string;
  centreName: string;
  issuedAt: Date;
}

export async function renderCertificatePdf(f: CertificateFacts): Promise<Buffer> {
  const qr = await QRCode.toBuffer(verifyUrl(f.verifyCode), { margin: 1, width: 220 });
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 50 });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const w = doc.page.width;
  doc.rect(25, 25, w - 50, doc.page.height - 50).lineWidth(3).stroke("#1f3a5f");
  doc.fontSize(14).fillColor("#555").text("PRAGATI SKILLS MISSION", 0, 70, { align: "center" });
  doc.fontSize(34).fillColor("#1f3a5f").text("Certificate of Completion", 0, 100, { align: "center" });
  doc.fontSize(14).fillColor("#555").text("This is to certify that", 0, 170, { align: "center" });
  doc.fontSize(30).fillColor("#000").text(f.holderName, 0, 200, { align: "center" });
  doc.fontSize(14).fillColor("#555").text("has successfully completed the programme", 0, 255, { align: "center" });
  doc.fontSize(22).fillColor("#1f3a5f").text(f.courseName, 0, 285, { align: "center" });
  doc.fontSize(12).fillColor("#555").text(`Training centre: ${f.centreName}`, 0, 330, { align: "center" });
  doc.fontSize(12).text(`Issued: ${f.issuedAt.toISOString().slice(0, 10)}`, 0, 350, { align: "center" });

  doc.image(qr, 60, 400, { width: 110 });
  doc.fontSize(11).fillColor("#000").text(`Certificate No: ${f.number}`, 190, 415);
  doc.text(`Verification code: ${formatCode(f.verifyCode)}`, 190, 435);
  doc.fontSize(9).fillColor("#555").text(`Verify at ${verifyUrl(f.verifyCode)}`, 190, 458, { width: 500 });
  doc.end();
  return done;
}

// Makes sure the PDF file exists (creating it if not) and returns its path. Safe to call
// any number of times, from the worker or the API: if the file is already there nothing
// is regenerated, and the write is atomic (temp file + rename).
export async function ensurePdf(certificateId: string): Promise<string> {
  const path = join(config.certDir, `${certificateId}.pdf`);
  if (existsSync(path)) return path;

  const cert = await prisma.certificate.findUniqueOrThrow({
    where: { id: certificateId },
    include: { candidate: true, batch: { include: { centre: true } } },
  });
  const pdf = await renderCertificatePdf({
    number: cert.number,
    verifyCode: cert.verifyCode,
    holderName: cert.candidate.name,
    courseName: cert.batch.courseName,
    centreName: cert.batch.centre.name,
    issuedAt: cert.createdAt,
  });
  await mkdir(config.certDir, { recursive: true });
  // Random temp name: two callers in the same process (or on different machines sharing
  // the folder) can never write the same temp file. Same content either way, so whoever
  // renames last simply replaces an identical file.
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, pdf);
  await rename(tmp, path);
  return path;
}
