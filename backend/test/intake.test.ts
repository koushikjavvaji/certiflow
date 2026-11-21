import request from "supertest";
import { describe, expect, it } from "vitest";

import { rawPrisma } from "../src/db";
import {
  U,
  api,
  app,
  batchRow,
  csvOf,
  makeBatch,
  makeSubmittedBatch,
  nextPhone,
  otherCentreToken,
  randomCourse,
} from "./helpers";

describe("MOMENT 1: a spreadsheet with a few bad rows", () => {
  it("reports exactly what is wrong, row by row, and saves nothing", async () => {
    const id = await makeBatch(0);
    const c = randomCourse();
    const dup = nextPhone();
    const csv = [
      "name,phone,courseCode,marks",
      `Asha Rao,${dup},${c},80`, // row 2: fine
      `Bad Phone,12345,${c},70`, // row 3: bad phone
      `X,${nextPhone()},${c},70`, // row 4: name too short
      `Over Marks,${nextPhone()},${c},150`, // row 5: marks out of range
      `Asha Again,${dup},${c},60`, // row 6: same person as row 2
      `Good One,${nextPhone()},${c},90`, // row 7: fine
    ].join("\n");

    const res = await (await api(U.anika)).put(`/batches/${id}/candidates`, { csv });
    expect(res.status).toBe(422);
    expect(res.body.totalErrors).toBe(4);
    const found = res.body.errors.map((e: { row: number; field: string }) => `${e.row}:${e.field}`).sort();
    expect(found).toEqual(["3:phone", "4:name", "5:marks", "6:phone"]);
    expect(res.body.errors.find((e: { row: number }) => e.row === 6).message).toContain("duplicate of row 2");

    // NOTHING half-saved: the two good rows were not stored either.
    expect(await rawPrisma.candidate.count({ where: { batchId: id } })).toBe(0);
    expect((await batchRow(id)).candidateCount).toBe(0);
  });

  it("after the centre fixes the sheet, every row is saved together", async () => {
    const id = await makeBatch(0);
    const res = await (await api(U.anika)).put(`/batches/${id}/candidates`, { csv: csvOf(8) });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(8);
    expect(await rawPrisma.candidate.count({ where: { batchId: id, isActive: true } })).toBe(8);
    expect((await batchRow(id)).candidateCount).toBe(8);
  });

  it("uploading again REPLACES the candidates instead of adding to them", async () => {
    const id = await makeBatch(5);
    await (await api(U.anika)).put(`/batches/${id}/candidates`, { csv: csvOf(3) });
    expect(await rawPrisma.candidate.count({ where: { batchId: id, isActive: true } })).toBe(3);
    expect((await batchRow(id)).candidateCount).toBe(3);
  });

  it("explains file-level problems: missing columns, empty file, too many rows", async () => {
    const id = await makeBatch(0);
    const anika = await api(U.anika);
    const missing = await anika.put(`/batches/${id}/candidates`, { csv: "name,phone\nAsha Rao,9876543210" });
    expect(missing.status).toBe(422);
    expect(missing.body.errors[0]).toMatchObject({ row: 0 });
    expect(missing.body.errors[0].message).toContain("coursecode");

    const empty = await anika.put(`/batches/${id}/candidates`, { csv: "name,phone,courseCode,marks\n" });
    expect(empty.status).toBe(422);

    const huge = await anika.put(`/batches/${id}/candidates`, { csv: csvOf(2001) });
    expect(huge.status).toBe(422);
    expect(huge.body.errors[0].message).toContain("too many rows");
  });

  it("accepts phone numbers written in common ways and stores one format", async () => {
    const id = await makeBatch(0);
    const c = randomCourse();
    const n = nextPhone();
    const csv = `Name,Phone,Course Code\nAsha Rao,+91 ${n.slice(0, 5)} ${n.slice(5)},${c}\n`;
    expect((await (await api(U.anika)).put(`/batches/${id}/candidates`, { csv })).status).toBe(200);
    const row = await rawPrisma.candidate.findFirstOrThrow({ where: { batchId: id } });
    expect(row.phone).toBe(`+91${n}`);
  });

  it("all-or-nothing also holds when two uploads fight over the same person at the same moment", async () => {
    const [a, b] = [await makeBatch(0), await makeBatch(0)];
    const c = randomCourse();
    const shared = nextPhone();
    const make = (extra: string) => `name,phone,courseCode\nShared Person,${shared},${c}\n${extra}`;
    const rowsFor = (n: number) =>
      Array.from({ length: n }, (_, i) => `Person ${i + 1},${nextPhone()},${c}`).join("\n");
    const anika = await api(U.anika);
    const [ra, rb] = await Promise.all([
      anika.put(`/batches/${a}/candidates`, { csv: make(rowsFor(9)) }),
      anika.put(`/batches/${b}/candidates`, { csv: make(rowsFor(9)) }),
    ]);
    expect([ra.status, rb.status].filter((s) => s === 200)).toHaveLength(1); // exactly one wins
    const loser = ra.status === 200 ? b : a;
    expect(await rawPrisma.candidate.count({ where: { batchId: loser, isActive: true } })).toBe(0); // loser left nothing behind
  });
});

describe("a person is certified once per course", () => {
  it("the same phone + course cannot be in two batches (clear error, no leak of whose batch)", async () => {
    const c = randomCourse();
    const phone = nextPhone();
    const first = await makeBatch(0);
    await (
      await api(U.anika)
    ).put(`/batches/${first}/candidates`, { csv: `name,phone,courseCode\nAsha Rao,${phone},${c}` });
    const second = await makeBatch(0);
    const res = await (
      await api(U.anika)
    ).put(`/batches/${second}/candidates`, { csv: `name,phone,courseCode\nAsha Rao,${phone},${c}` });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ row: 2, field: "phone" });
    expect(JSON.stringify(res.body)).not.toContain(first);
  });

  it("the database itself refuses the duplicate even if the check were skipped", async () => {
    const c = randomCourse();
    const phone = `+91${nextPhone()}`;
    const batch = await makeBatch(0);
    await rawPrisma.candidate.create({ data: { batchId: batch, name: "A One", phone, courseCode: c } });
    await expect(
      rawPrisma.candidate.create({ data: { batchId: batch, name: "A Two", phone, courseCode: c } }),
    ).rejects.toThrow();
  });
});

describe("only the owning centre can edit a batch", () => {
  it("another centre gets 'not found' for read, upload and submit", async () => {
    const id = await makeBatch(3);
    const stranger = { authorization: `Bearer ${await otherCentreToken()}` };
    expect((await request(app).get(`/batches/${id}`).set(stranger)).status).toBe(404);
    expect(
      (
        await request(app)
          .put(`/batches/${id}/candidates`)
          .set(stranger)
          .send({ csv: csvOf(2) })
      ).status,
    ).toBe(404);
    expect((await request(app).post(`/batches/${id}/submit`).set(stranger)).status).toBe(404);
    const list = await request(app).get("/batches").set(stranger);
    expect(list.body.batches.map((b: { id: string }) => b.id)).not.toContain(id);
  });

  it("officers cannot create batches or upload candidates", async () => {
    expect((await (await api(U.dev)).post("/batches", { courseName: "Welding" })).status).toBe(403);
    const id = await makeBatch(2);
    expect((await (await api(U.dev)).put(`/batches/${id}/candidates`, { csv: csvOf(2) })).status).toBe(403);
  });

  it("a batch under review can no longer be edited, and an empty batch cannot be submitted", async () => {
    const empty = await makeBatch(0);
    expect((await (await api(U.anika)).post(`/batches/${empty}/submit`)).status).toBe(422);
    const sent = await makeSubmittedBatch(3);
    expect((await (await api(U.anika)).put(`/batches/${sent}/candidates`, { csv: csvOf(2) })).status).toBe(409);
    expect((await (await api(U.anika)).post(`/batches/${sent}/submit`)).status).toBe(409);
  });

  it("rejects bad input: invalid ids, empty course name, missing body", async () => {
    const anika = await api(U.anika);
    expect((await anika.get("/batches/not-a-uuid")).status).toBe(400);
    expect((await anika.post("/batches", { courseName: " " })).status).toBe(400);
    expect((await anika.post("/batches", {})).status).toBe(400);
    expect((await anika.put(`/batches/${await makeBatch(0)}/candidates`, {})).status).toBe(400);
  });
});
