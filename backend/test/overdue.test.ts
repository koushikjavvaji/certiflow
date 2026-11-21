import { afterEach, describe, expect, it } from "vitest";
import { invalidateConfigCache } from "../src/config-store";
import { rawPrisma } from "../src/db";
import { subscribeLive, closeLive } from "../src/live";
import { scanOverdue } from "../src/maintenance";
import { api, approveOk, auditFor, batchRow, makeSubmittedBatch, U } from "./flow-helpers";

const days = (n: number) => n * 24 * 60 * 60 * 1000;

describe("MOMENT 5: a batch sits too long with an officer", () => {
  it("is flagged exactly once, on the record, and shows up in the state office's stuck list", async () => {
    const id = await makeSubmittedBatch(5);
    await scanOverdue(); // fresh batch: well within its 48-hour SLA
    expect((await batchRow(id)).overdueAt).toBeNull();

    const later = new Date(Date.now() + days(3));
    await scanOverdue(later);
    expect((await batchRow(id)).overdueAt).not.toBeNull();
    await scanOverdue(new Date(later.getTime() + 60_000)); // scanning again must not flag it again
    const flags = (await auditFor(id)).filter((a) => a.action === "BATCH_OVERDUE");
    expect(flags).toHaveLength(1);
    expect(flags[0]!.metadata).toMatchObject({ step: "DISTRICT_REVIEW", slaMinutes: 2880 });

    // Someone senior finds out without anyone chasing:
    const stuck = (await (await api(U.farah)).get("/batches?view=stuck")).body.batches as { id: string; overdue: boolean }[];
    expect(stuck.find((b) => b.id === id)?.overdue).toBe(true);
    expect((await (await api(U.dev)).get("/batches?view=stuck")).status).toBe(403); // not for everyone
    expect((await (await api(U.anika)).get("/batches?view=stuck")).status).toBe(403);
  });

  it("an overdue flag announces itself live", async () => {
    const id = await makeSubmittedBatch(5);
    const seen: string[] = [];
    const stop = subscribeLive((p) => seen.push(p));
    await new Promise((r) => setTimeout(r, 200));
    await scanOverdue(new Date(Date.now() + days(3)));
    await new Promise((r) => setTimeout(r, 300));
    stop();
    closeLive();
    expect(seen.some((p) => p.includes("batch.overdue") && p.includes(id))).toBe(true);
  });

  it("moving on to the next step starts a fresh clock", async () => {
    const id = await makeSubmittedBatch(5);
    await scanOverdue(new Date(Date.now() + days(3)));
    expect((await batchRow(id)).overdueAt).not.toBeNull();
    await approveOk(U.dev, id);
    await approveOk(U.meera, id);
    const row = await batchRow(id);
    expect(row.currentStepKey).toBe("STATE_REVIEW");
    expect(row.overdueAt).toBeNull();
  });

  describe("the SLA is a database setting, not code", () => {
    afterEach(async () => {
      await rawPrisma.workflowStep.updateMany({ where: { key: "DISTRICT_REVIEW" }, data: { slaMinutes: 2880 } });
      await invalidateConfigCache();
    });

    it("lowering slaMinutes to 1 flags a batch that has waited 2 minutes", async () => {
      await rawPrisma.workflowStep.updateMany({ where: { key: "DISTRICT_REVIEW" }, data: { slaMinutes: 1 } });
      await invalidateConfigCache();
      const id = await makeSubmittedBatch(5);
      await rawPrisma.batch.update({ where: { id }, data: { stepEnteredAt: new Date(Date.now() - 2 * 60_000) } });
      await scanOverdue();
      expect((await batchRow(id)).overdueAt).not.toBeNull();
    });
  });

  it("batches that are not waiting for review are never flagged", async () => {
    const draft = await rawPrisma.batch.create({ data: { centreId: "20000000-0000-4000-8000-000000000001", courseName: "x", status: "DRAFT" } });
    await scanOverdue(new Date(Date.now() + days(30)));
    expect((await batchRow(draft.id)).overdueAt).toBeNull();
  });
});
