import { Role } from "@prisma/client";
import { prisma } from "./db";

// Demo data. Fixed ids + upsert => safe to run on every startup (idempotent), and the
// same people have the same ids on every machine, which keeps tests and demos stable.
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

async function main() {
  for (const d of [
    { id: D_RIVERSIDE, name: "Riverside District" },
    { id: D_HILLVIEW, name: "Hillview District" },
  ]) {
    await prisma.district.upsert({ where: { id: d.id }, update: { name: d.name }, create: d });
  }

  for (const c of [
    { id: C_SUNRISE, name: "Sunrise Skills Centre", districtId: D_RIVERSIDE },
    { id: C_LAKESIDE, name: "Lakeside Training Institute", districtId: D_HILLVIEW },
  ]) {
    await prisma.centre.upsert({ where: { id: c.id }, update: { name: c.name, districtId: c.districtId }, create: c });
  }

  const users = [
    { id: DEMO_USER_IDS.anika, name: "Anika", role: Role.CENTRE, centreId: C_SUNRISE, districtId: null },
    { id: DEMO_USER_IDS.dev, name: "Dev", role: Role.DISTRICT_OFFICER, districtId: D_RIVERSIDE, centreId: null },
    { id: DEMO_USER_IDS.meera, name: "Meera", role: Role.DISTRICT_OFFICER, districtId: D_RIVERSIDE, centreId: null },
    { id: DEMO_USER_IDS.kabir, name: "Kabir", role: Role.DISTRICT_OFFICER, districtId: D_RIVERSIDE, centreId: null },
    { id: DEMO_USER_IDS.neha, name: "Neha", role: Role.QUALITY, districtId: null, centreId: null },
    { id: DEMO_USER_IDS.farah, name: "Farah", role: Role.STATE, districtId: null, centreId: null },
    // Not in the brief: an officer in a DIFFERENT district, so we can prove that
    // officers cannot see or act on another district's batches.
    { id: DEMO_USER_IDS.isha, name: "Isha", role: Role.DISTRICT_OFFICER, districtId: D_HILLVIEW, centreId: null },
  ];
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u.id }, update: u, create: u });
  }

  console.log(`seeded ${users.length} users, 2 districts, 2 centres`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
