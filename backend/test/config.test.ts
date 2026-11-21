import { execSync } from "node:child_process";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_TTL_SECONDS, invalidateConfigCache } from "../src/config-store";
import { rawPrisma } from "../src/db";
import { redis } from "../src/redis";
import { DEMO_USER_IDS, app, bearer, tokenFor } from "./helpers";

const getConfig = async () => {
  const res = await request(app)
    .get("/config")
    .set(bearer(await tokenFor(DEMO_USER_IDS.anika)));
  expect(res.status).toBe(200);
  return res.body as {
    settings: Record<string, unknown>;
    workflow: {
      version: number;
      steps: { key: string; requiredApprovals: number; condition: unknown; role: string; scope: string }[];
    };
  };
};

afterEach(async () => {
  // restore anything a test changed, then drop the cache so the next test sees real values
  await rawPrisma.setting.updateMany({ where: { key: "escalation.scanIntervalSeconds" }, data: { value: 60 } });
  await rawPrisma.workflowStep.updateMany({ where: { key: "DISTRICT_REVIEW" }, data: { requiredApprovals: 2 } });
  await invalidateConfigCache();
});

describe("rules are data in the database", () => {
  it("requires login to read the config", async () => {
    expect((await request(app).get("/config")).status).toBe(401);
  });

  it("serves the seeded approval path in order, with the brief's rules as data", async () => {
    const { workflow, settings } = await getConfig();
    expect(workflow.steps.map((s) => s.key)).toEqual(["DISTRICT_REVIEW", "QUALITY_REVIEW", "STATE_REVIEW"]);
    const [district, quality, state] = workflow.steps;
    expect(district).toMatchObject({ role: "DISTRICT_OFFICER", scope: "DISTRICT", requiredApprovals: 2 });
    expect(quality).toMatchObject({ role: "QUALITY", condition: { minCandidates: 50 } });
    expect(state).toMatchObject({ role: "STATE", requiredApprovals: 1 });
    expect(settings["resubmit.resetApprovals"]).toBe(true);
  });

  it("a database edit changes behaviour with no code change or redeploy", async () => {
    expect((await getConfig()).workflow.steps[0]?.requiredApprovals).toBe(2);

    await rawPrisma.workflowStep.updateMany({ where: { key: "DISTRICT_REVIEW" }, data: { requiredApprovals: 3 } });
    await rawPrisma.setting.updateMany({ where: { key: "escalation.scanIntervalSeconds" }, data: { value: 5 } });
    await invalidateConfigCache(); // what the TTL does automatically within seconds

    const after = await getConfig();
    expect(after.workflow.steps[0]?.requiredApprovals).toBe(3);
    expect(after.settings["escalation.scanIntervalSeconds"]).toBe(5);
  });

  it("config is cached in Redis with a short expiry so edits are picked up quickly", async () => {
    await invalidateConfigCache();
    await getConfig();
    const ttl = await redis.ttl("cfg:settings");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CACHE_TTL_SECONDS);
  });

  it("the database itself rejects nonsense config", async () => {
    await expect(
      rawPrisma.workflowStep.updateMany({ where: { key: "DISTRICT_REVIEW" }, data: { requiredApprovals: 0 } }),
    ).rejects.toThrow();
    await expect(
      rawPrisma.workflowStep.updateMany({ where: { key: "DISTRICT_REVIEW" }, data: { slaMinutes: -5 } }),
    ).rejects.toThrow();
  });

  it("two active steps cannot share a position or a key", async () => {
    await expect(
      rawPrisma.workflowStep.create({
        data: { workflowVersion: 1, position: 1, key: "OTHER", name: "dup position", role: "STATE" },
      }),
    ).rejects.toThrow();
    await expect(
      rawPrisma.workflowStep.create({
        data: { workflowVersion: 1, position: 9, key: "STATE_REVIEW", name: "dup key", role: "STATE" },
      }),
    ).rejects.toThrow();
  });

  it("seeding again never overwrites a value edited in the database", async () => {
    await rawPrisma.setting.updateMany({ where: { key: "escalation.scanIntervalSeconds" }, data: { value: 7 } });
    execSync("npx tsx src/seed.ts", { stdio: "pipe" });
    const row = await rawPrisma.setting.findFirst({ where: { key: "escalation.scanIntervalSeconds", isActive: true } });
    expect(row?.value).toBe(7);
  });
});
