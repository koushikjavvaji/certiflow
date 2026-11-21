import type { Prisma } from "@prisma/client";

import type { AuthUser } from "./auth";
import { forbidden, notFound } from "./chain";
import { getWorkflow, type WorkflowStepConfig } from "./config-store";
import { prisma } from "./db";
import { formatCode } from "./pdf";
import { canActAtStep, canView } from "./workflow";

// Read side: what each person is allowed to see, and which buttons make sense for them.
// The server works out `actions` so the UI never has to re-implement the rules.

export type View = "waiting" | "all" | "stuck";

const ROLE_NAME: Record<string, string> = {
  DISTRICT_OFFICER: "District officer",
  QUALITY: "Quality team",
  STATE: "State office",
  CENTRE: "Training centre",
};

const maskPhone = (p: string) => `${p.slice(0, 3)}${"*".repeat(Math.max(0, p.length - 7))}${p.slice(-4)}`;

// Visibility of batches in LISTS (single batches go through canView).
function visibleTo(user: AuthUser): Prisma.BatchWhereInput {
  if (user.role === "CENTRE") return { centreId: user.centreId ?? "00000000-0000-0000-0000-000000000000" };
  if (user.role === "DISTRICT_OFFICER")
    return { centre: { districtId: user.districtId ?? "00000000-0000-0000-0000-000000000000" } };
  return {};
}

async function stepsFor(versions: number[]) {
  const map = new Map<number, WorkflowStepConfig[]>();
  for (const v of new Set(versions)) map.set(v, await getWorkflow(v));
  return map;
}

const AUDIT_LIMIT = 500; // newest events of a batch; a huge batch keeps its latest history, not its earliest
const ALL_VIEW_LIMIT = 200; // the open-ended "all" list is capped; "waiting" and "stuck" are not
const OPEN_REVIEW_LIMIT = 1000; // safety net for the in-review lists

export async function listBatches(user: AuthUser, view: View) {
  if (view === "stuck" && user.role !== "STATE") throw forbidden("only the state office sees stuck batches");

  // "waiting" and "stuck" only ever concern batches under review, so the database narrows them down
  // first and lists the longest-waiting ones first. (Filtering after a cap would let a batch that has
  // waited for days drop off the list behind newer ones: the very case we must not miss.)
  const scope: Prisma.BatchWhereInput =
    view === "stuck"
      ? { status: "IN_REVIEW", overdueAt: { not: null } }
      : view === "waiting"
        ? { status: "IN_REVIEW" }
        : {};
  const batches = await prisma.batch.findMany({
    where: { ...visibleTo(user), ...scope },
    include: { centre: { select: { name: true, districtId: true } } },
    orderBy: view === "all" ? { updatedAt: "desc" } : { stepEnteredAt: "asc" },
    take: view === "all" ? ALL_VIEW_LIMIT : OPEN_REVIEW_LIMIT,
  });
  const ids = batches.map((b) => b.id);
  const [approvals, steps] = await Promise.all([
    prisma.approval.findMany({
      where: { batchId: { in: ids } },
      select: { batchId: true, batchVersion: true, stepKey: true, officerId: true },
    }),
    stepsFor(batches.map((b) => b.workflowVersion)),
  ]);

  const summaries = batches.map((b) => {
    const step = steps.get(b.workflowVersion)?.find((s) => s.key === b.currentStepKey);
    const here = approvals.filter(
      (a) => a.batchId === b.id && a.batchVersion === b.version && a.stepKey === b.currentStepKey,
    );
    const iApproved = here.some((a) => a.officerId === user.id);
    const myTurn = b.status === "IN_REVIEW" && !!step && canActAtStep(user, step, { centre: b.centre });
    return {
      id: b.id,
      courseName: b.courseName,
      centreName: b.centre.name,
      status: b.status,
      candidateCount: b.candidateCount,
      stepKey: b.currentStepKey,
      stepName: step?.name ?? null,
      approvalsHave: here.length,
      approvalsNeed: step?.requiredApprovals ?? null,
      overdue: b.overdueAt !== null && b.status === "IN_REVIEW",
      lastReason: b.status === "CHANGES_REQUESTED" || b.status === "REJECTED" ? b.lastReason : null,
      waitingForMe: myTurn && !iApproved,
      updatedAt: b.updatedAt,
    };
  });
  return view === "waiting" ? summaries.filter((s) => s.waitingForMe) : summaries;
}

export async function getBatchDetail(user: AuthUser, batchId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: { centre: { select: { name: true, districtId: true } } },
  });
  if (!batch || !canView(user, batch)) throw notFound("batch not found");

  const [candidates, approvals, auditNewestFirst, certificates, steps] = await Promise.all([
    prisma.candidate.findMany({ where: { batchId }, orderBy: { createdAt: "asc" } }),
    prisma.approval.findMany({ where: { batchId, batchVersion: batch.version } }),
    prisma.auditLog.findMany({ where: { batchId }, orderBy: { createdAt: "desc" }, take: AUDIT_LIMIT }),
    prisma.certificate.findMany({
      where: { batchId },
      include: { candidate: { select: { name: true } }, _count: { select: { attempts: true } } },
      orderBy: { number: "asc" },
    }),
    getWorkflow(batch.workflowVersion),
  ]);
  const audit = [...auditNewestFirst].reverse(); // oldest to newest for the screen
  // Who is who. A training centre must NOT learn which individual officer did what (that is
  // the officers' own profile); it sees the role instead ("District officer"), plus its
  // own name on its own actions. Staff see names, because accountability is their job.
  const peopleIds = [
    ...new Set([...approvals.map((a) => a.officerId), ...audit.map((a) => a.actorId).filter((x): x is string => !!x)]),
  ];
  const people = await prisma.user.findMany({
    where: { id: { in: peopleIds } },
    select: { id: true, name: true, role: true },
  });
  const known = new Map(people.map((p) => [p.id, p]));
  const hideNames = user.role === "CENTRE";
  const whoIs = (id: string | null, storedName: string | null): string => {
    if (!id) return "system";
    if (!hideNames || id === user.id) return storedName ?? known.get(id)?.name ?? "unknown";
    return ROLE_NAME[known.get(id)?.role ?? ""] ?? "Reviewer";
  };

  const step = steps.find((s) => s.key === batch.currentStepKey) ?? null;
  const here = approvals.filter((a) => a.stepKey === batch.currentStepKey);
  const iApproved = here.some((a) => a.officerId === user.id);
  const myTurn = batch.status === "IN_REVIEW" && !!step && canActAtStep(user, step, batch);
  const mine = user.role === "CENTRE";
  const editable = mine && (batch.status === "DRAFT" || batch.status === "CHANGES_REQUESTED");

  const actions: string[] = [];
  if (editable) actions.push("UPLOAD");
  if (editable && batch.candidateCount > 0) actions.push("SUBMIT");
  if (myTurn && !iApproved) actions.push("APPROVE");
  if (myTurn) actions.push("SEND_BACK", "REJECT");
  if (myTurn && iApproved) actions.push("WITHDRAW");
  if (user.role === "STATE") actions.push("CANCEL_CERTIFICATE", "RETRY_DELIVERY");

  const showCodes = user.role === "STATE" || user.role === "CENTRE";
  return {
    batch: {
      id: batch.id,
      courseName: batch.courseName,
      centreName: batch.centre.name,
      status: batch.status,
      version: batch.version,
      candidateCount: batch.candidateCount,
      lastReason: batch.lastReason,
      overdue: batch.overdueAt !== null && batch.status === "IN_REVIEW",
      stepKey: batch.currentStepKey,
      stepName: step?.name ?? null,
      stepEnteredAt: batch.stepEnteredAt,
      approvalsNeed: step?.requiredApprovals ?? null,
      createdAt: batch.createdAt,
    },
    approvals: here.map((a) => ({
      officer: whoIs(a.officerId, known.get(a.officerId)?.name ?? null),
      at: a.updatedAt,
    })),
    candidates: candidates.map((c) => ({
      id: c.id,
      name: c.name,
      phone: mine ? c.phone : maskPhone(c.phone),
      courseCode: c.courseCode,
      marks: c.marks,
    })),
    certificates: certificates.map((c) => ({
      id: c.id,
      number: c.number,
      holder: c.candidate.name,
      status: c.status,
      deliveryStatus: c.deliveryStatus,
      attempts: c._count.attempts,
      deliveredAt: c.deliveredAt,
      cancelReason: c.cancelReason,
      verifyCode: showCodes ? formatCode(c.verifyCode) : undefined,
    })),
    audit: audit.map((a) => ({
      id: a.id,
      at: a.createdAt,
      actor: whoIs(a.actorId, a.actorName),
      action: a.action,
      reason: a.reason,
      metadata: a.metadata,
      correlationId: a.correlationId,
    })),
    actions,
  };
}
