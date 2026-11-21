import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { Handler, chainOf } from "../src/chain";
import { invalidateConfigCache, type WorkflowStepConfig } from "../src/config-store";
import { rawPrisma } from "../src/db";
import { closeLive, subscribeLive } from "../src/redis";
import { StepChain } from "../src/workflow";
import {
  U,
  api,
  approveOk,
  auditFor,
  batchRow,
  bearer,
  csvOf,
  decide,
  makeBatch,
  makeSubmittedBatch,
  tokenFor,
} from "./helpers";

const approvalCount = (batchId: string) => rawPrisma.approval.count({ where: { batchId, isActive: true } });
const stepsCompleted = async (batchId: string) =>
  (await auditFor(batchId)).filter((a) => a.action === "STEP_COMPLETED").length;

describe("the approval path follows the rules stored in the database", () => {
  it("small batch: two district approvals, then the state office (quality is skipped)", async () => {
    const id = await makeSubmittedBatch(49);
    expect((await batchRow(id)).currentStepKey).toBe("DISTRICT_REVIEW");
    await approveOk(U.dev, id);
    expect((await batchRow(id)).currentStepKey).toBe("DISTRICT_REVIEW"); // one is not enough
    await approveOk(U.meera, id);
    expect((await batchRow(id)).currentStepKey).toBe("STATE_REVIEW");
    await approveOk(U.farah, id);
    expect((await batchRow(id)).status).toBe("APPROVED");
  });

  it("big batch (50 or more): the quality team reviews between district and state", async () => {
    const id = await makeSubmittedBatch(50);
    await approveOk(U.dev, id);
    await approveOk(U.meera, id);
    expect((await batchRow(id)).currentStepKey).toBe("QUALITY_REVIEW");
    expect((await decide(U.farah, id, "APPROVE")).status).toBe(403); // the state office cannot skip ahead
    await approveOk(U.neha, id);
    expect((await batchRow(id)).currentStepKey).toBe("STATE_REVIEW");
    await approveOk(U.farah, id);
    expect((await batchRow(id)).status).toBe("APPROVED");
  });

  describe("changing a rule in the database changes behaviour (no code change)", () => {
    afterEach(async () => {
      await rawPrisma.workflowStep.updateMany({ where: { key: "DISTRICT_REVIEW" }, data: { requiredApprovals: 2 } });
      await invalidateConfigCache();
    });

    it("requiredApprovals = 1 means a single officer moves the batch on", async () => {
      await rawPrisma.workflowStep.updateMany({ where: { key: "DISTRICT_REVIEW" }, data: { requiredApprovals: 1 } });
      await invalidateConfigCache();
      const id = await makeSubmittedBatch(5);
      await approveOk(U.dev, id);
      expect((await batchRow(id)).currentStepKey).toBe("STATE_REVIEW");
    });

    it("requiredApprovals = 3 needs all three officers", async () => {
      await rawPrisma.workflowStep.updateMany({ where: { key: "DISTRICT_REVIEW" }, data: { requiredApprovals: 3 } });
      await invalidateConfigCache();
      const id = await makeSubmittedBatch(5);
      await approveOk(U.dev, id);
      await approveOk(U.meera, id);
      expect((await batchRow(id)).currentStepKey).toBe("DISTRICT_REVIEW");
      await approveOk(U.kabir, id);
      expect((await batchRow(id)).currentStepKey).toBe("STATE_REVIEW");
    });
  });
});

describe("the 'waiting for me' list", () => {
  it("lists the longest-waiting batch first, so an old file can never hide behind newer ones", async () => {
    const older = await makeSubmittedBatch(3);
    const newer = await makeSubmittedBatch(3);
    // pretend the older one has been waiting for days
    await rawPrisma.batch.update({
      where: { id: older },
      data: { stepEnteredAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    const waiting = (await (await api(U.dev)).get("/batches?view=waiting")).body.batches as { id: string }[];
    const ids = waiting.map((b) => b.id);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
  });

  it("only shows batches whose current step is the person's own", async () => {
    const id = await makeSubmittedBatch(3);
    const idsFor = async (userId: string) =>
      ((await (await api(userId)).get("/batches?view=waiting")).body.batches as { id: string }[]).map((b) => b.id);
    expect(await idsFor(U.dev)).toContain(id); // district step: Dev's turn
    expect(await idsFor(U.farah)).not.toContain(id); // not the state office's turn yet
    expect(await idsFor(U.isha)).not.toContain(id); // another district
    await approveOk(U.dev, id);
    expect(await idsFor(U.dev)).not.toContain(id); // already approved: no longer waiting for Dev
    expect(await idsFor(U.meera)).toContain(id);
  });
});

describe("MOMENT 2: officers act at the same moment", () => {
  it("two officers approving together move the batch forward exactly once", async () => {
    const id = await makeSubmittedBatch(5);
    const [a, b] = await Promise.all([decide(U.dev, id, "APPROVE"), decide(U.meera, id, "APPROVE")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await batchRow(id)).currentStepKey).toBe("STATE_REVIEW");
    expect(await approvalCount(id)).toBe(2);
    expect(await stepsCompleted(id)).toBe(1); // moved on ONCE, not twice
  });

  it("the race is won correctly every time: 12 batches, two officers each, all at once", async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => makeSubmittedBatch(3)));
    const results = await Promise.all(
      ids.flatMap((id) => [decide(U.dev, id, "APPROVE"), decide(U.meera, id, "APPROVE")]),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const id of ids) {
      expect((await batchRow(id)).currentStepKey).toBe("STATE_REVIEW"); // none stuck at the district step
      expect(await approvalCount(id)).toBe(2);
      expect(await stepsCompleted(id)).toBe(1); // none moved twice
    }
  });

  it("three officers at once: two count, the late third is told it is no longer their turn", async () => {
    const id = await makeSubmittedBatch(5);
    const results = await Promise.all([U.dev, U.meera, U.kabir].map((u) => decide(u, id, "APPROVE")));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 403]);
    expect(await approvalCount(id)).toBe(2);
    expect(await stepsCompleted(id)).toBe(1);
    expect((await batchRow(id)).currentStepKey).toBe("STATE_REVIEW");
  });

  it("one officer clicking twice at once is counted once", async () => {
    const id = await makeSubmittedBatch(5);
    const results = await Promise.all([decide(U.dev, id, "APPROVE"), decide(U.dev, id, "APPROVE")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await approvalCount(id)).toBe(1);
    expect((await batchRow(id)).currentStepKey).toBe("DISTRICT_REVIEW");
  });

  it("an officer cannot approve the same step twice, even one after the other", async () => {
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    const again = await decide(U.dev, id, "APPROVE");
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("already approved");
  });
});

describe("NEVER: acting at a step that is not yours", () => {
  it("the wrong role is refused at every step", async () => {
    const id = await makeSubmittedBatch(5);
    expect((await decide(U.neha, id, "APPROVE")).status).toBe(403); // quality at the district step
    expect((await decide(U.farah, id, "APPROVE")).status).toBe(403); // state at the district step
    expect((await decide(U.anika, id, "APPROVE")).status).toBe(403); // the centre cannot approve its own batch
    await approveOk(U.dev, id);
    await approveOk(U.meera, id);
    expect((await decide(U.dev, id, "APPROVE")).status).toBe(403); // officer at the state step
    expect((await decide(U.dev, id, "REJECT", "nope")).status).toBe(403);
    expect((await decide(U.neha, id, "SEND_BACK", "nope")).status).toBe(403);
    expect((await batchRow(id)).status).toBe("IN_REVIEW"); // nothing changed
  });

  it("an officer of ANOTHER district cannot see or act on the batch", async () => {
    const id = await makeSubmittedBatch(5);
    const isha = await api(U.isha);
    expect((await isha.get(`/batches/${id}`)).status).toBe(404);
    expect((await decide(U.isha, id, "APPROVE")).status).toBe(404);
    const list = await isha.get("/batches?view=all");
    expect(list.body.batches.map((b: { id: string }) => b.id)).not.toContain(id);
    expect(await approvalCount(id)).toBe(0);
  });

  it("deciding on a batch that is not under review is refused", async () => {
    const draft = await makeBatch(3);
    expect((await decide(U.dev, draft, "APPROVE")).status).toBe(409);
    const done = await makeSubmittedBatch(5);
    await decide(U.dev, done, "REJECT", "not eligible");
    expect((await decide(U.meera, done, "APPROVE")).status).toBe(409);
  });

  it("the server tells each person which actions exist for them (and withholds the rest)", async () => {
    const id = await makeSubmittedBatch(5);
    const actions = async (u: string) => (await (await api(u)).get(`/batches/${id}`)).body.actions as string[];
    expect(await actions(U.dev)).toEqual(expect.arrayContaining(["APPROVE", "SEND_BACK", "REJECT"]));
    expect(await actions(U.neha)).not.toContain("APPROVE");
    expect(await actions(U.anika)).toEqual([]);
    await approveOk(U.dev, id);
    const afterApproval = await actions(U.dev);
    expect(afterApproval).toContain("WITHDRAW");
    expect(afterApproval).not.toContain("APPROVE");
  });
});

describe("officers can fix their own mistakes", () => {
  it("an approval can be withdrawn while the batch is still at that step, and made again", async () => {
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    expect(await approvalCount(id)).toBe(1);
    expect((await (await api(U.dev)).post(`/batches/${id}/withdraw`)).status).toBe(200);
    expect(await approvalCount(id)).toBe(0);
    await approveOk(U.dev, id); // allowed again after withdrawing
    expect(await approvalCount(id)).toBe(1);
    expect((await auditFor(id)).map((a) => a.action)).toContain("APPROVAL_WITHDRAWN");
  });

  it("nobody can withdraw someone else's approval, or one they never gave", async () => {
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    expect((await (await api(U.kabir)).post(`/batches/${id}/withdraw`)).status).toBe(409);
    expect(await approvalCount(id)).toBe(1);
  });

  it("once the batch has moved on, the old approval can no longer be withdrawn", async () => {
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    await approveOk(U.meera, id);
    expect((await (await api(U.dev)).post(`/batches/${id}/withdraw`)).status).toBe(403);
  });
});

describe("MOMENT 6: sent back, fixed and resubmitted", () => {
  it("send-back needs a reason; the centre sees it", async () => {
    const id = await makeSubmittedBatch(5);
    expect((await decide(U.dev, id, "SEND_BACK")).status).toBe(400);
    expect((await decide(U.dev, id, "SEND_BACK", "  ")).status).toBe(400);
    expect((await decide(U.dev, id, "SEND_BACK", "Marks look wrong for row 3")).status).toBe(200);
    const detail = (await (await api(U.anika)).get(`/batches/${id}`)).body;
    expect(detail.batch.status).toBe("CHANGES_REQUESTED");
    expect(detail.batch.lastReason).toBe("Marks look wrong for row 3");
    expect(detail.actions).toEqual(expect.arrayContaining(["UPLOAD", "SUBMIT"]));
  });

  it("DEFAULT RULE: earlier approvals are discarded and review restarts from the first step", async () => {
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id); // 1 of 2 at the district step
    await decide(U.meera, id, "SEND_BACK", "please fix");
    const anika = await api(U.anika);
    await anika.put(`/batches/${id}/candidates`, { csv: csvOf(5) });
    expect((await anika.post(`/batches/${id}/submit`)).status).toBe(200);

    const row = await batchRow(id);
    expect(row.status).toBe("IN_REVIEW");
    expect(row.version).toBe(2);
    expect(row.currentStepKey).toBe("DISTRICT_REVIEW");
    const detail = (await (await api(U.dev)).get(`/batches/${id}`)).body;
    expect(detail.approvals).toHaveLength(0); // Dev's earlier approval no longer counts
    await approveOk(U.dev, id); // and Dev must approve again (not "already approved")
    expect(await rawPrisma.approval.count({ where: { batchId: id } })).toBe(2); // the old one is kept as history
    expect((await auditFor(id)).map((a) => a.action)).toContain("BATCH_RESUBMITTED");
  });

  describe("when the setting says keep approvals", () => {
    afterEach(async () => {
      await rawPrisma.setting.updateMany({ where: { key: "resubmit.resetApprovals" }, data: { value: true } });
      await invalidateConfigCache();
    });

    it("the same step resumes and earlier approvals still count (a database edit, no code change)", async () => {
      await rawPrisma.setting.updateMany({ where: { key: "resubmit.resetApprovals" }, data: { value: false } });
      await invalidateConfigCache();
      const id = await makeSubmittedBatch(5);
      await approveOk(U.dev, id);
      await decide(U.meera, id, "SEND_BACK", "please fix");
      const anika = await api(U.anika);
      await anika.put(`/batches/${id}/candidates`, { csv: csvOf(5) });
      await anika.post(`/batches/${id}/submit`);
      const row = await batchRow(id);
      expect(row.version).toBe(1);
      expect(row.currentStepKey).toBe("DISTRICT_REVIEW");
      expect((await (await api(U.dev)).get(`/batches/${id}`)).body.approvals).toHaveLength(1);
    });
  });
});

describe("rejecting closes the batch", () => {
  it("needs a reason, ends the batch, and frees its people to be submitted again", async () => {
    const course = "REJ" + Math.floor(Math.random() * 1e6);
    const csv = csvOf(3, course);
    const id = await makeBatch(0);
    await (await api(U.anika)).put(`/batches/${id}/candidates`, { csv });
    await (await api(U.anika)).post(`/batches/${id}/submit`);
    expect((await decide(U.dev, id, "REJECT")).status).toBe(400);
    expect((await decide(U.dev, id, "REJECT", "Fraudulent attendance")).status).toBe(200);
    expect((await batchRow(id)).status).toBe("REJECTED");
    const again = await makeBatch(0);
    expect((await (await api(U.anika)).put(`/batches/${again}/candidates`, { csv })).status).toBe(200);
  });
});

describe("NEVER: a decision that cannot be traced", () => {
  it("every decision records who, what, when and why", async () => {
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    await decide(U.meera, id, "SEND_BACK", "Need clearer marks");
    const trail = await auditFor(id);
    const approve = trail.find((a) => a.action === "STEP_APPROVED")!;
    expect(approve).toMatchObject({ actorId: U.dev, actorName: "Dev", entityType: "Batch", entityId: id });
    expect(approve.createdAt).toBeInstanceOf(Date);
    const back = trail.find((a) => a.action === "BATCH_SENT_BACK")!;
    expect(back).toMatchObject({ actorId: U.meera, actorName: "Meera", reason: "Need clearer marks" });
    expect(trail.map((a) => a.action)).toEqual(
      expect.arrayContaining(["BATCH_CREATED", "CANDIDATES_UPLOADED", "BATCH_SUBMITTED"]),
    );
  });

  it("the trail is readable by those allowed to see the batch", async () => {
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    const detail = (await (await api(U.meera)).get(`/batches/${id}`)).body;
    expect(
      detail.audit.some((a: { actor: string; action: string }) => a.actor === "Dev" && a.action === "STEP_APPROVED"),
    ).toBe(true);
  });

  it("the database refuses to edit, delete or truncate the audit log", async () => {
    const id = await makeSubmittedBatch(3);
    const row = (await auditFor(id))[0]!;
    await expect(rawPrisma.auditLog.update({ where: { id: row.id }, data: { reason: "edited" } })).rejects.toThrow(
      /append-only/,
    );
    await expect(rawPrisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(rawPrisma.$executeRawUnsafe(`TRUNCATE "AuditLog"`)).rejects.toThrow(/append-only/);
    expect(await rawPrisma.auditLog.count({ where: { id: row.id } })).toBe(1);
  });

  it("a request id given by the caller is stored with the decision (follow one story end to end)", async () => {
    const id = await makeSubmittedBatch(5);
    const traceId = `trace-${Date.now()}-abcd`;
    await (await api(U.dev)).post(`/batches/${id}/decision`, { decision: "APPROVE" }, { "x-request-id": traceId });
    const rows = await rawPrisma.auditLog.findMany({ where: { correlationId: traceId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ batchId: id, actorName: "Dev" });
  });
});

describe("NEVER: a stranger seeing someone's personal details", () => {
  it("officers see masked phone numbers; only the owning centre sees them in full", async () => {
    const id = await makeSubmittedBatch(3);
    const forCentre = (await (await api(U.anika)).get(`/batches/${id}`)).body.candidates[0].phone as string;
    const forOfficer = (await (await api(U.dev)).get(`/batches/${id}`)).body.candidates[0].phone as string;
    expect(forCentre).toMatch(/^\+91\d{10}$/);
    expect(forOfficer).not.toBe(forCentre);
    expect(forOfficer).toContain("*");
    expect(forOfficer.endsWith(forCentre.slice(-4))).toBe(true);
  });

  it("a training centre never sees which individual officer acted (only the role); staff see names", async () => {
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    await decide(U.meera, id, "SEND_BACK", "please fix the marks");
    const forCentre = (await (await api(U.anika)).get(`/batches/${id}`)).body;
    const text = JSON.stringify(forCentre);
    for (const officer of ["Dev", "Meera", "Kabir", "Neha", "Farah"]) expect(text).not.toContain(`"${officer}"`);
    expect(
      forCentre.audit.some(
        (a: { actor: string; action: string }) => a.actor === "District officer" && a.action === "BATCH_SENT_BACK",
      ),
    ).toBe(true);
    expect(forCentre.audit.some((a: { actor: string }) => a.actor === "Anika")).toBe(true); // her own actions keep her name
    expect(forCentre.batch.lastReason).toBe("please fix the marks"); // the reason is still shown

    const forStaff = (await (await api(U.kabir)).get(`/batches/${id}`)).body;
    expect(forStaff.audit.some((a: { actor: string }) => a.actor === "Dev")).toBe(true);
    expect(forStaff.audit.some((a: { actor: string }) => a.actor === "Meera")).toBe(true);
  });

  it("the approvals list shows a centre roles, not names", async () => {
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    const forCentre = (await (await api(U.anika)).get(`/batches/${id}`)).body;
    expect(forCentre.approvals).toHaveLength(1);
    expect(forCentre.approvals[0].officer).toBe("District officer");
    expect((await (await api(U.meera)).get(`/batches/${id}`)).body.approvals[0].officer).toBe("Dev");
  });

  it("anonymous callers get nothing from batch endpoints", async () => {
    const id = await makeSubmittedBatch(3);
    const anon = (await import("supertest")).default(createApp({ demoMode: true }));
    expect((await anon.get(`/batches/${id}`)).status).toBe(401);
    expect((await anon.get("/batches")).status).toBe(401);
    expect((await anon.post(`/batches/${id}/decision`).send({ decision: "APPROVE" })).status).toBe(401);
  });
});

describe("everyone sees changes as they happen", () => {
  it("a decision produces a live event for the batch", async () => {
    const id = await makeSubmittedBatch(5);
    const seen: string[] = [];
    const stop = subscribeLive((p) => seen.push(p));
    await new Promise((r) => setTimeout(r, 200)); // let the subscription connect
    await approveOk(U.dev, id);
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(seen.some((p) => p.includes(id) && p.includes("batch.updated"))).toBe(true);
    closeLive();
  });

  it("the /events stream needs a login and delivers events to a connected browser", async () => {
    const server = createApp({ demoMode: true }).listen(0);
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/events`)).status).toBe(401);
      const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: bearer(await tokenFor(U.farah)) });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      await reader.read(); // ": connected"
      await new Promise((r) => setTimeout(r, 300));
      const id = await makeBatch(1); // triggers batch.updated
      let text = "";
      const end = Date.now() + 5000;
      while (!text.includes(id) && Date.now() < end) {
        const { value } = await reader.read();
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain("batch.updated");
      expect(text).toContain(id);
      await reader.cancel();
    } finally {
      server.closeAllConnections();
      server.close();
      closeLive();
    }
  });
});

// ====================== The chain of responsibility itself ======================
describe("the generic chain (chain.ts)", () => {
  // A tiny handler that records its name; `stops` makes it "handle" the request.
  class Note extends Handler<string[]> {
    constructor(
      private word: string,
      private stops = false,
    ) {
      super();
    }
    protected process(log: string[]) {
      log.push(this.word);
      return this.stops;
    }
  }

  it("passes the request along in order, to the end", async () => {
    const log: string[] = [];
    await chainOf<string[]>(new Note("a"), new Note("b"), new Note("c")).handle(log);
    expect(log).toEqual(["a", "b", "c"]);
  });

  it("stops at the first handler that handles it", async () => {
    const log: string[] = [];
    await chainOf<string[]>(new Note("a"), new Note("b", true), new Note("c")).handle(log);
    expect(log).toEqual(["a", "b"]);
  });

  it("a handler that refuses (throws) rejects the whole request and nothing after it runs", async () => {
    class Refuse extends Handler<string[]> {
      protected process(): boolean {
        throw new Error("refused");
      }
    }
    const log: string[] = [];
    await expect(chainOf<string[]>(new Note("a"), new Refuse(), new Note("c")).handle(log)).rejects.toThrow("refused");
    expect(log).toEqual(["a"]);
  });
});

describe("the approval path as a chain of step handlers (step-chain.ts)", () => {
  const step = (position: number, key: string, minCandidates?: number): WorkflowStepConfig => ({
    position,
    key,
    name: key,
    role: "STATE",
    scope: "ANY",
    requiredApprovals: 1,
    slaMinutes: null,
    condition: minCandidates === undefined ? null : { minCandidates },
  });

  it("links the steps in position order, however they arrive", () => {
    const chain = new StepChain([step(3, "C"), step(1, "A"), step(2, "B")]);
    expect(chain.first(10)?.key).toBe("A");
    expect(chain.get("A")?.nextApplicable(10)?.key).toBe("B");
    expect(chain.get("B")?.nextApplicable(10)?.key).toBe("C");
    expect(chain.get("C")?.nextApplicable(10)).toBeNull(); // end of the chain: approved
  });

  it("skips steps that do not apply to this batch (the 'big batch' rule)", () => {
    const chain = new StepChain([step(1, "DISTRICT"), step(2, "QUALITY", 50), step(3, "STATE")]);
    expect(chain.get("DISTRICT")?.nextApplicable(49)?.key).toBe("STATE");
    expect(chain.get("DISTRICT")?.nextApplicable(50)?.key).toBe("QUALITY");
  });

  it("starts at the first step that applies, and an empty chain means 'nothing to ask'", () => {
    expect(new StepChain([step(1, "BIG_ONLY", 100), step(2, "STATE")]).first(5)?.key).toBe("STATE");
    expect(new StepChain([]).first(5)).toBeNull();
  });

  it("a resubmitted batch resumes where it was sent back, unless that step no longer applies", () => {
    const chain = new StepChain([step(1, "A"), step(2, "B", 50), step(3, "C")]);
    expect(chain.resume("B", 60)?.key).toBe("B");
    expect(chain.resume("B", 10)?.key).toBe("A"); // B no longer applies: start over
    expect(chain.resume("GONE", 10)?.key).toBe("A");
    expect(chain.resume(null, 10)?.key).toBe("A");
  });

  it("a step is satisfied by enough approvals", () => {
    const two = new StepChain([{ ...step(1, "A"), requiredApprovals: 2 }]).get("A")!;
    expect([two.isSatisfiedBy(1), two.isSatisfiedBy(2), two.isSatisfiedBy(3)]).toEqual([false, true, true]);
  });
});

describe("ADDING A STEP is adding a row (no code change)", () => {
  const addAuditStep = async (condition: object | null) => {
    await rawPrisma.workflowStep.updateMany({
      where: { key: "STATE_REVIEW", workflowVersion: 1 },
      data: { position: 4 },
    }); // make room
    await rawPrisma.workflowStep.create({
      data: {
        workflowVersion: 1,
        position: 3,
        key: "AUDIT_REVIEW",
        name: "Audit review",
        role: "QUALITY",
        scope: "ANY",
        requiredApprovals: 1,
        slaMinutes: 2880,
        condition: condition as never,
      },
    });
    await invalidateConfigCache();
  };

  afterEach(async () => {
    await rawPrisma.workflowStep.deleteMany({ where: { key: "AUDIT_REVIEW" } }); // hard delete: it was only a test row
    await rawPrisma.workflowStep.updateMany({
      where: { key: "STATE_REVIEW", workflowVersion: 1 },
      data: { position: 3 },
    });
    await invalidateConfigCache();
  });

  it("a new step sits in the chain: every batch must pass it, in order, by the right role", async () => {
    await addAuditStep(null);
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    await approveOk(U.meera, id);
    expect((await batchRow(id)).currentStepKey).toBe("AUDIT_REVIEW"); // the NEW step, between district and state
    expect((await decide(U.farah, id, "APPROVE")).status).toBe(403); // the state office cannot skip the audit
    expect((await decide(U.dev, id, "APPROVE")).status).toBe(403); // and it is not the district's turn any more
    await approveOk(U.neha, id);
    expect((await batchRow(id)).currentStepKey).toBe("STATE_REVIEW");
    await approveOk(U.farah, id);
    expect((await batchRow(id)).status).toBe("APPROVED");
  });

  it("a new step can apply only to some batches (its condition), others skip it", async () => {
    await addAuditStep({ minCandidates: 100 });
    const small = await makeSubmittedBatch(5);
    await approveOk(U.dev, small);
    await approveOk(U.meera, small);
    expect((await batchRow(small)).currentStepKey).toBe("STATE_REVIEW"); // 5 < 100: audit skipped
  });

  it("the screens show the new step by themselves", async () => {
    await addAuditStep(null);
    const id = await makeSubmittedBatch(5);
    await approveOk(U.dev, id);
    await approveOk(U.meera, id);
    const detail = (await (await api(U.neha)).get(`/batches/${id}`)).body;
    expect(detail.batch.stepName).toBe("Audit review");
    expect(detail.actions).toContain("APPROVE"); // Neha is offered the button
    expect(
      (await (await api(U.neha)).get("/batches?view=waiting")).body.batches.some((b: { id: string }) => b.id === id),
    ).toBe(true);
  });
});
