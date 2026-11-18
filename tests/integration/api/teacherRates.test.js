/**
 * How a teacher's hour is paid (Eden, 2026-11-18): one rate, a rate for a
 * private lesson and another for a group, or a rate by the number of
 * students in the lesson - saved on the teacher, and what the month's
 * invoices are checked against, lesson by lesson.
 */

const request = require("supertest");
const app = require("../../../app");
const { makeTeacher, makeStudent, makeCycle, makeSubject, makeEnrollment } = require("../../helpers/factories");

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMAGE = `data:image/png;base64,${PNG_B64}`;
const span = { startDate: new Date("2026-09-01"), endDate: new Date("2026-12-31") };

/**
 * October 2026, the college: one teacher with a PRIVATE course (Mondays 10:00-10:45, one student) and a GROUP
 * course (Wednesdays 16:00-17:30, three students - one of them left in the middle of the month).
 */
async function month() {
  const teacher = await makeTeacher({ firstName: "נעה", lastName: "מורה" });
  const piano = await makeSubject({ name: "פסנתר" });
  const choir = await makeSubject({ name: "מקהלה" });
  const priv = await makeCycle({ subject: piano._id, teacher: teacher._id, ...span, matching: { format: "Private", capacity: 1 }, schedule: [{ day: 1, start: "10:00", end: "10:45" }] });
  const group = await makeCycle({ subject: choir._id, teacher: teacher._id, ...span, matching: { format: "Group", capacity: 8 }, schedule: [{ day: 3, start: "16:00", end: "17:30" }] });
  await makeEnrollment({ cycle: priv._id, student: (await makeStudent())._id, status: "active", joinedAt: new Date("2026-09-01") });
  for (let i = 0; i < 2; i++) await makeEnrollment({ cycle: group._id, student: (await makeStudent())._id, status: "active", joinedAt: new Date("2026-09-01") });
  // the third sat in the group until the 15th
  await makeEnrollment({ cycle: group._id, student: (await makeStudent())._id, status: "left", joinedAt: new Date("2026-09-01"), leftAt: new Date("2026-10-15") });
  return { teacher, priv, group };
}
const save = (teacher, body) => request(app).put(`/api/people/${teacher._id}`).send(body);
const openRound = async () => (await request(app).post("/api/invoice-rounds").send({ month: "2026-10", program: "college" })).body.data.round;
const readRound = async (id) => (await request(app).get(`/api/invoice-rounds/${id}`)).body.data.round;

describe("how a teacher's hour is paid", () => {
  it("one rate: the month is its hours by the rate, and no session is of another price", async () => {
    const { teacher } = await month();
    const saved = await save(teacher, { hourlyRate: 100 });
    expect(saved.body.data.person).toMatchObject({ hourlyRate: 100, rateMode: "fixed", rateTiers: [] });
    const r = (await openRound()).requests[0];
    // October 2026: 4 Mondays of 45 minutes, 4 Wednesdays of an hour and a half = 3 + 6 hours
    expect(r.sessions).toHaveLength(8);
    expect(r.money.rate).toEqual({ kind: "hour", value: 100 });
    expect(r.money).toMatchObject({ hours: 9, expected: 900, parts: null });
    expect(r.sessions.map((s) => s.pay).sort((a, b) => a - b)).toEqual([75, 75, 75, 75, 150, 150, 150, 150]);
    expect(r.sessions.every((s) => s.students === null)).toBe(true);
  });

  it("private / group: every lesson is paid by its kind, the sum is the hours under each price", async () => {
    const { teacher } = await month();
    // the prices are needed, both: a mode without them falls back to the one rate
    await save(teacher, { rateMode: "format", hourlyRate: 100 });
    const round = await openRound();
    expect(round.requests[0].money.rate).toEqual({ kind: "hour", value: 100 });
    const saved = await save(teacher, { rateMode: "format", ratePrivate: 80, rateGroup: 120 });
    expect(saved.status).toBe(200);
    expect(saved.body.data.person).toMatchObject({ rateMode: "format", ratePrivate: 80, rateGroup: 120 });

    const r = (await readRound(round._id)).requests[0];
    expect(r.money.rate).toEqual({ kind: "hour", mode: "format", private: 80, group: 120, value: null });
    expect(r.teacher.rates).toMatchObject({ mode: "format", private: 80, group: 120 });
    const priv = r.sessions.filter((s) => s.format === "Private");
    const group = r.sessions.filter((s) => s.format === "Group");
    expect([priv.length, group.length]).toEqual([4, 4]);
    expect(priv.every((s) => s.pay === 60) && group.every((s) => s.pay === 180)).toBe(true);
    // 3 private hours at 80 + 6 group hours at 120
    expect(r.money).toMatchObject({ hours: 9, expected: 960 });

    // behind the teacher's link: an invoice on one private and one group lesson is checked against 60 + 180
    await request(app).post(`/api/invoice-rounds/${round._id}/requests/${r._id}/mode`).send({ mode: "check" });
    const token = (await request(app).get(`/api/invoice-rounds/${round._id}/requests/${r._id}/link`)).body.data.link.token;
    const url = `/api/public/invoices/${token}`;
    const view = (await request(app).get(url)).body.data.view;
    expect(view.rate).toMatchObject({ mode: "format", private: 80, group: 120 });
    const all = view.courses.flatMap((c) => c.sessions);
    expect(all.every((s) => s.format === "Private" || s.format === "Group")).toBe(true);
    const one = all.find((s) => s.format === "Private");
    const two = all.find((s) => s.format === "Group");
    const off = await request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: "a.png", sessions: [one._id, two._id], number: "1001", amount: 300 });
    expect(off.body.code).toBe("INVOICE_EXPLAIN_REQUIRED");
    const up = await request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: "a.png", sessions: [one._id, two._id], number: "1001", amount: 240 });
    expect(up.status).toBe(200);
    expect(up.body.data.view.invoices[0].check).toMatchObject({ expected: 240, hours: 2.25, sessions: 2, verdict: "match", diff: 0, rate: null, rateKind: "hour" });
    const after = (await readRound(round._id)).requests[0];
    expect(after.money).toMatchObject({ expectedBilled: 240, hoursBilled: 2.25, invoiced: 240, verdict: "match" });
    expect(after.money.parts).toEqual([
      { key: "group", hours: 1.5, sessions: 1, rate: 120, sum: 180 },
      { key: "private", hours: 0.75, sessions: 1, rate: 80, sum: 60 },
    ]);
    // the coordinator's own typing is checked by the same arithmetic
    const typed = await request(app).patch(`/api/invoices/${after.invoices[0]._id}`).send({ amount: 250 });
    expect(typed.body.data.invoice.check).toMatchObject({ expected: 240, verdict: "high", diff: 10 });
    // the ledger names both prices
    expect((await request(app).get(`/api/invoice-rounds/${round._id}/ledger.xlsx`)).status).toBe(200);
  });

  it("by the number of students: every lesson is counted by who sat in it that day", async () => {
    const { teacher } = await month();
    // the first step starts at one student, and the steps climb
    expect((await save(teacher, { rateMode: "count", rateTiers: [{ from: 2, value: 100 }] })).status).toBe(400);
    expect((await save(teacher, { rateMode: "count", rateTiers: [{ from: 1, value: 70 }, { from: 1, value: 90 }] })).status).toBe(400);
    const saved = await save(teacher, { rateMode: "count", rateTiers: [{ from: 1, value: 70 }, { from: 3, value: 110 }] });
    expect(saved.status).toBe(200);
    expect(saved.body.data.person.rateTiers).toEqual([{ from: 1, value: 70 }, { from: 3, value: 110 }]);

    const r = (await openRound()).requests[0];
    expect(r.money.rate).toEqual({ kind: "hour", mode: "count", tiers: [{ from: 1, value: 70 }, { from: 3, value: 110 }], value: null });
    const day = (s) => s.date.slice(0, 10);
    const priv = r.sessions.filter((s) => s.format === "Private");
    const group = r.sessions.filter((s) => s.format === "Group").sort((a, b) => day(a).localeCompare(day(b)));
    expect(priv.every((s) => s.students === 1 && s.pay === 52.5)).toBe(true);
    // the Wednesdays of October 2026: 7, 14 (three sit), 21, 28 (two - one left on the 15th)
    expect(group.map((s) => [day(s), s.students, s.pay])).toEqual([
      ["2026-10-07", 3, 165],
      ["2026-10-14", 3, 165],
      ["2026-10-21", 2, 105],
      ["2026-10-28", 2, 105],
    ]);
    // 3 private hours + 3 group hours of two at 70, 3 group hours of three at 110
    expect(r.money).toMatchObject({ hours: 9, expected: 750 });

    // back to one rate: the steps stay written and are not read
    await save(teacher, { rateMode: "fixed", hourlyRate: 90 });
    const again = (await readRound((await request(app).get("/api/invoice-rounds")).body.data.rounds[0]._id)).requests[0];
    expect(again.money.rate).toEqual({ kind: "hour", value: 90 });
    expect(again.money.expected).toBe(810);
    expect(again.sessions.every((s) => s.students === null)).toBe(true);
  });
});
