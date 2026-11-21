import { afterAll, describe, expect, it } from "vitest";

import { prisma, rawPrisma } from "../src/db";
import { DEMO_USER_IDS } from "./helpers";

const created: string[] = [];
const uniqueName = (p: string) => `${p}-${crypto.randomUUID()}`;
async function makeDistrict(name: string) {
  const d = await prisma.district.create({ data: { name } });
  created.push(d.id);
  return d;
}
afterAll(async () => {
  await rawPrisma.district.deleteMany({ where: { id: { in: created } } }); // real cleanup
});

describe("standard columns on every table", () => {
  it("new rows get id, createdAt, updatedAt, isActive = true and an empty meta object", async () => {
    const d = await makeDistrict(uniqueName("std"));
    expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.createdAt).toBeInstanceOf(Date);
    expect(d.isActive).toBe(true);
    expect(d.meta).toEqual({});
  });

  it("updatedAt moves forward when a row changes", async () => {
    const d = await makeDistrict(uniqueName("upd"));
    await new Promise((r) => setTimeout(r, 15));
    const after = await prisma.district.update({ where: { id: d.id }, data: { name: uniqueName("upd2") } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(d.updatedAt.getTime());
  });

  it("meta stores new attributes with no migration", async () => {
    const d = await makeDistrict(uniqueName("meta"));
    const updated = await prisma.district.update({ where: { id: d.id }, data: { meta: { region: "north", code: 7 } } });
    expect(updated.meta).toEqual({ region: "north", code: 7 });
  });
});

describe("soft delete", () => {
  it("delete() hides the row from normal queries but keeps it in the table", async () => {
    const d = await makeDistrict(uniqueName("soft"));
    await prisma.district.delete({ where: { id: d.id } });

    expect(await prisma.district.findUnique({ where: { id: d.id } })).toBeNull();
    expect(await prisma.district.findFirst({ where: { id: d.id } })).toBeNull();
    expect(await prisma.district.findMany({ where: { id: d.id } })).toHaveLength(0);
    expect(await prisma.district.count({ where: { id: d.id } })).toBe(0);

    const raw = await rawPrisma.district.findUnique({ where: { id: d.id } });
    expect(raw).not.toBeNull();
    expect(raw?.isActive).toBe(false);
  });

  it("deleteMany() is soft too", async () => {
    const d = await makeDistrict(uniqueName("softmany"));
    await prisma.district.deleteMany({ where: { id: d.id } });
    expect(await prisma.district.count({ where: { id: d.id } })).toBe(0);
    expect((await rawPrisma.district.findUnique({ where: { id: d.id } }))?.isActive).toBe(false);
  });

  it("a soft-deleted name can be reused, but two ACTIVE rows cannot share a name", async () => {
    const name = uniqueName("reuse");
    const first = await makeDistrict(name);
    await expect(prisma.district.create({ data: { name } })).rejects.toThrow(); // active duplicate blocked
    await prisma.district.delete({ where: { id: first.id } });
    const second = await makeDistrict(name); // allowed now
    expect(second.id).not.toBe(first.id);
  });
});

describe("database rejects bad people data", () => {
  const riverside = "10000000-0000-4000-8000-000000000001";
  const sunrise = "20000000-0000-4000-8000-000000000001";

  it("a centre user must have a centre and no district", async () => {
    await expect(rawPrisma.user.create({ data: { name: "x", role: "CENTRE" } })).rejects.toThrow();
    await expect(
      rawPrisma.user.create({ data: { name: "x", role: "CENTRE", centreId: sunrise, districtId: riverside } }),
    ).rejects.toThrow();
  });

  it("a district officer must have a district and no centre", async () => {
    await expect(rawPrisma.user.create({ data: { name: "x", role: "DISTRICT_OFFICER" } })).rejects.toThrow();
    await expect(
      rawPrisma.user.create({
        data: { name: "x", role: "DISTRICT_OFFICER", districtId: riverside, centreId: sunrise },
      }),
    ).rejects.toThrow();
  });

  it("quality and state users must have neither", async () => {
    await expect(
      rawPrisma.user.create({ data: { name: "x", role: "STATE", districtId: riverside } }),
    ).rejects.toThrow();
    await expect(rawPrisma.user.create({ data: { name: "x", role: "QUALITY", centreId: sunrise } })).rejects.toThrow();
  });

  it("seed data satisfies the rules (7 demo people exist exactly once)", async () => {
    const users = await prisma.user.findMany({ where: { id: { in: Object.values(DEMO_USER_IDS) } } });
    expect(users).toHaveLength(7);
  });
});
