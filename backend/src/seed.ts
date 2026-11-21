import { Role, StepScope } from "@prisma/client";
import { disconnectDb, rawPrisma as db } from "./db";

// Demo data. Safe to run on every startup (idempotent):
//   - people / districts / centres use fixed ids + upsert, so ids are the same on every
//     machine (stable tests and demos);
//   - CONFIG rows (settings, workflow steps) are created only if missing and NEVER
//     overwritten, so a value someone edited in the database survives a restart.
const D_RIVERSIDE = "10000000-0000-4000-8000-000000000001";
const D_HILLVIEW = "10000000-0000-4000-8000-000000000002";
const C_SUNRISE = "20000000-0000-4000-8000-000000000001";
const C_LAKESIDE = "20000000-0000-4000-8000-000000000002";

export const DEMO_USER_IDS = {
  anika: "30000000-0000-4000-8000-000000000001",
  dev: "30000000-0000-4000-8000-000000000002",
  meera: "30000000-0000-4000-8000-000000000003",
  kabir: "30000000-0000-4000-8000-000000000004",
  neha: "30000000-0000-4000-8000-000000000005",
  farah: "30000000-0000-4000-8000-000000000006",
  isha: "30000000-0000-4000-8000-000000000007",
} as const;

const MINUTES_48H = 48 * 60;

async function seedPeople() {
  for (const d of [
    { id: D_RIVERSIDE, name: "Riverside District" },
    { id: D_HILLVIEW, name: "Hillview District" },
  ]) {
    await db.district.upsert({ where: { id: d.id }, update: { name: d.name, deletedAt: null }, create: d });
  }

  for (const c of [
    { id: C_SUNRISE, name: "Sunrise Skills Centre", districtId: D_RIVERSIDE },
    { id: C_LAKESIDE, name: "Lakeside Training Institute", districtId: D_HILLVIEW },
  ]) {
    await db.centre.upsert({
      where: { id: c.id },
      update: { name: c.name, districtId: c.districtId, deletedAt: null },
      create: c,
    });
  }

  const users = [
    { id: DEMO_USER_IDS.anika, name: "Anika", role: Role.CENTRE, centreId: C_SUNRISE, districtId: null },
    { id: DEMO_USER_IDS.dev, name: "Dev", role: Role.DISTRICT_OFFICER, districtId: D_RIVERSIDE, centreId: null },
    { id: DEMO_USER_IDS.meera, name: "Meera", role: Role.DISTRICT_OFFICER, districtId: D_RIVERSIDE, centreId: null },
    { id: DEMO_USER_IDS.kabir, name: "Kabir", role: Role.DISTRICT_OFFICER, districtId: D_RIVERSIDE, centreId: null },
    { id: DEMO_USER_IDS.neha, name: "Neha", role: Role.QUALITY, districtId: null, centreId: null },
    { id: DEMO_USER_IDS.farah, name: "Farah", role: Role.STATE, districtId: null, centreId: null },
    // Not in the brief: an officer in a DIFFERENT district, so we can prove officers
    // cannot see or act on another district's batches.
    { id: DEMO_USER_IDS.isha, name: "Isha", role: Role.DISTRICT_OFFICER, districtId: D_HILLVIEW, centreId: null },
  ];
  for (const u of users) {
    await db.user.upsert({ where: { id: u.id }, update: { ...u, deletedAt: null }, create: u });
  }
  return users.length;
}

async function seedSettings() {
  const defaults: { key: string; value: unknown; description: string }[] = [
    {
      key: "workflow.activeVersion",
      value: 1,
      description: "Which WorkflowStep version new batches use. Publish a new version, then point this at it.",
    },
    {
      key: "resubmit.resetApprovals",
      value: true,
      description:
        "When a sent-back batch is fixed and resubmitted, discard earlier approvals (the data changed, so they no longer apply).",
    },
    {
      key: "escalation.scanIntervalSeconds",
      value: 60,
      description: "How often the stuck-batch scan runs. Lower it for demos.",
    },
  ];
  for (const s of defaults) {
    const exists = await db.setting.findFirst({ where: { key: s.key, deletedAt: null } });
    if (!exists) await db.setting.create({ data: { key: s.key, value: s.value as never, description: s.description } });
  }
}

async function seedWorkflow() {
  const steps = [
    {
      position: 1,
      key: "DISTRICT_REVIEW",
      name: "District review",
      role: Role.DISTRICT_OFFICER,
      scope: StepScope.DISTRICT,
      requiredApprovals: 2, // brief: "a district decision needs more than one officer to agree"
      slaMinutes: MINUTES_48H,
      condition: null,
    },
    {
      position: 2,
      key: "QUALITY_REVIEW",
      name: "Quality review (big batches)",
      role: Role.QUALITY,
      scope: StepScope.ANY,
      requiredApprovals: 1,
      slaMinutes: MINUTES_48H,
      condition: { minCandidates: 50 }, // brief: "big batches need extra scrutiny"
    },
    {
      position: 3,
      key: "STATE_REVIEW",
      name: "State final approval",
      role: Role.STATE,
      scope: StepScope.ANY,
      requiredApprovals: 1,
      slaMinutes: MINUTES_48H,
      condition: null,
    },
  ];
  for (const s of steps) {
    const exists = await db.workflowStep.findFirst({ where: { workflowVersion: 1, key: s.key, deletedAt: null } });
    if (!exists) await db.workflowStep.create({ data: { workflowVersion: 1, ...s, condition: s.condition as never } });
  }
}

async function main() {
  const people = await seedPeople();
  await seedSettings();
  await seedWorkflow();
  console.log(`seeded: ${people} users, 2 districts, 2 centres, settings, workflow v1`);
}

// Only run when executed directly (tests import DEMO_USER_IDS without seeding).
if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(disconnectDb);
}
