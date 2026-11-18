/**
 * The hostels teachers' week census (Eden, 2026-11-18): a form a teacher,
 * a personal link with a day it closes and a record of its openings, the
 * week written by the teacher or by the staff, handed in - and nothing of
 * the real courses touched.
 */

const request = require("supertest");
const app = require("../../../app");
const Cycle = require("../../../models/Cycle");
const WeekPlan = require("../../../models/WeekPlan");
const { makeTeacher, makeHostel, makeCycle, makeSubject } = require("../../helpers/factories");

async function world() {
  const hostel = await makeHostel({ name: "השלום", kind: "hostel" });
  const subject = await makeSubject({ name: "קרמיקה" });
  const tomer = await makeTeacher({ firstName: "תומר", lastName: "דורון", gender: "male", phone: "052-1112233" });
  const noa = await makeTeacher({ firstName: "נועה", lastName: "שכטר", gender: "female" });
  // תומר teaches in a house; נועה does not (a college course only)
  await makeCycle({ subject: subject._id, teacher: tomer._id, hostel: hostel._id, startDate: new Date("2026-01-01"), endDate: new Date("2027-07-31"), schedule: [{ day: 1, start: "10:00", end: "11:00" }] });
  await makeCycle({ subject: subject._id, teacher: noa._id, startDate: new Date("2026-01-01"), endDate: new Date("2027-07-31"), schedule: [{ day: 2, start: "10:00", end: "11:00" }] });
  return { hostel, subject, tomer, noa };
}
const entry = (w, over = {}) => ({ day: 1, start: "10:00", end: "11:30", subject: "קרמיקה", hostel: String(w.hostel._id), place: "hostel", ...over });

describe("the hostels teachers' week census", () => {
  it("offers the teachers of a house's course, opens a form each, and never hands the token in a list", async () => {
    const w = await world();
    const first = (await request(app).get("/api/week-plans")).body.data;
    expect(first.plans).toEqual([]);
    expect(first.suggested).toEqual([String(w.tomer._id)]);
    const opened = await request(app).post("/api/week-plans").send({ teachers: [String(w.tomer._id), String(w.noa._id)] });
    expect(opened.status).toBe(201);
    expect(opened.body.data.plans).toHaveLength(2);
    expect(JSON.stringify(opened.body)).not.toMatch(/"token"/);
    // twice adds nothing
    expect((await request(app).post("/api/week-plans").send({ teachers: [String(w.tomer._id)] })).body.data.plans).toHaveLength(0);
    const list = (await request(app).get("/api/week-plans")).body.data;
    expect(list.plans.map((p) => p.teacher.firstName).sort()).toEqual(["נועה", "תומר"]);
    expect(list.suggested).toEqual([]);
    expect(list.plans[0]).toMatchObject({ live: true, opens: 0, sentAt: null, openedAt: null, submittedAt: null, entries: [] });
    expect(JSON.stringify(list)).not.toMatch(/"token"/);
    // the link is handed alone, with the day it closes; the day can be named
    const plan = list.plans.find((p) => p.teacher.firstName === "תומר");
    const link = (await request(app).get(`/api/week-plans/${plan._id}/link`)).body.data.link;
    expect(link.url).toMatch(new RegExp(`/week/${link.token}$`));
    const until = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const renewed = (await request(app).post(`/api/week-plans/${plan._id}/renew`).send({ until })).body.data.plan;
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(Date.now() + 4 * 86400000);
    expect((await request(app).post(`/api/week-plans/${plan._id}/sent`)).body.data.plan.sentAt).toBeTruthy();
  });

  it("the teacher behind the link: every opening is noted, the week is written, checked and handed in", async () => {
    const w = await world();
    const plan = (await request(app).post("/api/week-plans").send({ teachers: [String(w.tomer._id)] })).body.data.plans[0];
    const token = (await request(app).get(`/api/week-plans/${plan._id}/link`)).body.data.link.token;
    expect((await request(app).get("/api/public/week-plans/nothing-like-a-token")).status).toBe(404);
    const view = (await request(app).get(`/api/public/week-plans/${token}`)).body.data.view;
    expect(view).toMatchObject({ teacher: { firstName: "תומר", gender: "male" }, live: true, entries: [], submittedAt: null });
    expect(view.hostels.map((h) => h.name)).toContain("השלום");
    expect(view.subjects).toContain("קרמיקה");
    expect(JSON.stringify(view)).not.toMatch(/052-1112233|"token"/);
    await request(app).get(`/api/public/week-plans/${token}`);
    const seen = (await request(app).get("/api/week-plans")).body.data.plans[0];
    expect(seen.opens).toBe(2);
    expect(seen.openedAt).toBeTruthy();
    expect(new Date(seen.lastOpenedAt).getTime()).toBeGreaterThanOrEqual(new Date(seen.openedAt).getTime());

    // nothing to hand in yet
    expect((await request(app).post(`/api/public/week-plans/${token}/done`).send({})).body.code).toBe("WEEK_PLAN_EMPTY");
    // an entry is whole, or it is refused
    const post = (body) => request(app).post(`/api/public/week-plans/${token}/entries`).send(body);
    for (const bad of [entry(w, { day: 5 }), entry(w, { end: "09:00" }), entry(w, { subject: " " }), entry(w, { place: "moon" }), entry(w, { hostel: null }), entry(w, { hostel: "6ad6000000000000000000aa" }), entry(w, { start: "9:00" })]) {
      expect((await post(bad)).body.code).toBe("WEEK_PLAN_ENTRY_INVALID");
    }
    const one = await post(entry(w));
    expect(one.status).toBe(201);
    expect(one.body.data.view.entries[0]).toMatchObject({ day: 1, start: "10:00", end: "11:30", subject: "קרמיקה", place: "hostel", by: "teacher", byName: "תומר דורון", hostel: { name: "השלום" } });
    // a house that is not on the list is written by name; a lesson at שק״ל
    const two = await post(entry(w, { day: 3, start: "16:00", end: "17:00", hostel: null, hostelName: "בית חדש", place: "shekel" }));
    expect(two.body.data.view.entries.map((e) => [e.day, e.place, e.hostelName])).toEqual([[1, "hostel", ""], [3, "shekel", "בית חדש"]]);
    const id = two.body.data.view.entries[1]._id;
    const fixed = await request(app).put(`/api/public/week-plans/${token}/entries/${id}`).send(entry(w, { day: 3, start: "16:30", end: "17:30", place: "shekel" }));
    expect(fixed.body.data.view.entries[1]).toMatchObject({ start: "16:30", hostel: { name: "השלום" }, hostelName: "" });
    expect((await request(app).delete(`/api/public/week-plans/${token}/entries/${id}`)).body.data.view.entries).toHaveLength(1);
    const done = await request(app).post(`/api/public/week-plans/${token}/done`).send({ note: "בחגים אין" });
    expect(done.body.data.view.submittedAt).toBeTruthy();
    const after = (await request(app).get("/api/week-plans")).body.data.plans[0];
    expect(after).toMatchObject({ note: "בחגים אין" });
    expect(after.submittedAt && after.teacherEditedAt).toBeTruthy();
    // a week with no lessons is handed in with a word
    const noa = (await request(app).post("/api/week-plans").send({ teachers: [String(w.noa._id)] })).body.data.plans[0];
    const t2 = (await request(app).get(`/api/week-plans/${noa._id}/link`)).body.data.link.token;
    expect((await request(app).post(`/api/public/week-plans/${t2}/done`).send({ note: "אין לי שיעורים קבועים בהוסטלים" })).body.data.view.submittedAt).toBeTruthy();

    // a closed link takes nothing more (reading stays); the staff open it again by naming a day
    await WeekPlan.updateOne({ _id: plan._id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await post(entry(w, { day: 2 }))).body.code).toBe("WEEK_PLAN_LINK_CLOSED");
    expect((await request(app).get(`/api/public/week-plans/${token}`)).body.data.view.live).toBe(false);
    await request(app).post(`/api/week-plans/${plan._id}/renew`).send({ days: 7 });
    expect((await post(entry(w, { day: 2 }))).status).toBe(201);
  });

  it("the staff write a teacher's week themselves, and the real courses stay as they were", async () => {
    const w = await world();
    const before = JSON.stringify(await Cycle.find().sort({ _id: 1 }).lean());
    const plan = (await request(app).post("/api/week-plans").send({ teachers: [String(w.tomer._id)] })).body.data.plans[0];
    const made = await request(app).post(`/api/week-plans/${plan._id}/entries`).send(entry(w, { day: 0, note: "קבוצה ב׳" }));
    expect(made.status).toBe(201);
    expect(made.body.data.plan.entries[0]).toMatchObject({ day: 0, by: "staff", note: "קבוצה ב׳" });
    const id = made.body.data.plan.entries[0]._id;
    expect((await request(app).put(`/api/week-plans/${plan._id}/entries/${id}`).send(entry(w, { day: 4 }))).body.data.plan.entries[0].day).toBe(4);
    expect((await request(app).post(`/api/week-plans/${plan._id}/entries`).send(entry(w, { end: "08:00" }))).body.code).toBe("WEEK_PLAN_ENTRY_INVALID");
    expect((await request(app).delete(`/api/week-plans/${plan._id}/entries/${id}`)).body.data.plan.entries).toHaveLength(0);
    // handed in, then opened again by the staff
    const token = (await request(app).get(`/api/week-plans/${plan._id}/link`)).body.data.link.token;
    await request(app).post(`/api/public/week-plans/${token}/done`).send({ note: "אין" });
    expect((await request(app).post(`/api/week-plans/${plan._id}/reopen`)).body.data.plan.submittedAt).toBeNull();
    expect(JSON.stringify(await Cycle.find().sort({ _id: 1 }).lean())).toBe(before);
    expect((await request(app).delete(`/api/week-plans/${plan._id}`)).status).toBe(204);
    expect(await WeekPlan.countDocuments()).toBe(0);
  });
});
