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
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { makeTeacher, makeHostel, makeCycle, makeSubject } = require("../../helpers/factories");

afterEach(() => Object.assign(TEST_ACCOUNT, { name: "בדיקות", kind: "super" }));

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

  it("a form opens in Hebrew unless Arabic is named, the staff can turn it, and the teacher's page is told", async () => {
    const w = await world();
    const [he] = (await request(app).post("/api/week-plans").send({ teachers: [String(w.tomer._id)] })).body.data.plans;
    const [ar] = (await request(app).post("/api/week-plans").send({ teachers: [String(w.noa._id)], lang: "ar" })).body.data.plans;
    expect([he.lang, ar.lang]).toEqual(["he", "ar"]);
    const token = (await request(app).get(`/api/week-plans/${he._id}/link`)).body.data.link.token;
    expect((await request(app).get(`/api/public/week-plans/${token}`)).body.data.view.lang).toBe("he");
    expect((await request(app).post(`/api/week-plans/${he._id}/lang`).send({ lang: "ar" })).body.data.plan.lang).toBe("ar");
    expect((await request(app).get(`/api/public/week-plans/${token}`)).body.data.view.lang).toBe("ar");
    expect((await request(app).post(`/api/week-plans/${he._id}/lang`).send({ lang: "fr" })).status).toBe(400);
    expect((await request(app).get("/api/week-plans")).body.data.plans.map((p) => p.lang).sort()).toEqual(["ar", "ar"]);
  });

  it("one person's form for several teachers: a fresh start sets the old aside, and every lesson names its teacher", async () => {
    const w = await world();
    const [mine, hers] = (await request(app).post("/api/week-plans").send({ teachers: [String(w.tomer._id), String(w.noa._id)] })).body.data.plans.sort((a) => (a.teacher.firstName === "תומר" ? -1 : 1));
    const token = (await request(app).get(`/api/week-plans/${mine._id}/link`)).body.data.link.token;
    const herToken = (await request(app).get(`/api/week-plans/${hers._id}/link`)).body.data.link.token;
    // what stood before: a lesson of his handed in, a word of hers with no lesson
    await request(app).post(`/api/public/week-plans/${token}/entries`).send(entry(w));
    await request(app).post(`/api/public/week-plans/${token}/done`).send({ note: "" });
    await request(app).post(`/api/public/week-plans/${herToken}/done`).send({ note: "בהוסטל משלוש עד ארבע" });
    await request(app).post(`/api/week-plans/${mine._id}/sent`);

    const fresh = (await request(app).post(`/api/week-plans/${mine._id}/aside`)).body.data.plan;
    expect(fresh).toMatchObject({ entries: [], note: "", submittedAt: null, sentAt: null, opens: 0, openedAt: null });
    expect(fresh.aside).toHaveLength(1);
    expect(fresh.aside[0]).toMatchObject({ subject: "קרמיקה", by: "teacher" });
    // twice sets nothing more aside
    expect((await request(app).post(`/api/week-plans/${mine._id}/aside`)).body.data.plan.aside).toHaveLength(1);

    expect((await request(app).post(`/api/week-plans/${mine._id}/cover`).send({ teachers: [] })).status).toBe(400);
    expect((await request(app).post(`/api/week-plans/${mine._id}/cover`).send({ teachers: [String(w.noa._id)], hostel: String(w.subject._id) })).status).toBe(400);
    const covered = (await request(app).post(`/api/week-plans/${mine._id}/cover`).send({ teachers: [String(w.noa._id)], hostel: String(w.hostel._id) })).body.data.plan;
    expect(covered.covers.map((c) => c.firstName)).toEqual(["תומר", "נועה"]);
    expect(covered.coversHostel).toMatchObject({ name: "השלום" });

    // the filler's page: who the form is for, and what stands in each one's own form
    const view = (await request(app).get(`/api/public/week-plans/${token}`)).body.data.view;
    expect(view.covers.map((c) => c.name)).toEqual(["תומר דורון", "נועה שכטר"]);
    expect(view.others).toEqual([{ _id: String(w.noa._id), name: "נועה שכטר", lessons: 0, note: "בהוסטל משלוש עד ארבע" }]);
    expect(view).toMatchObject({ asideLessons: 1, entries: [], coversHostel: { name: "השלום" } });

    // a lesson with no teacher, or with one who is not of the form, is refused - by the link and by the staff
    const post = (body) => request(app).post(`/api/public/week-plans/${token}/entries`).send(body);
    expect((await post(entry(w))).body.code).toBe("WEEK_PLAN_ENTRY_TEACHER");
    expect((await post(entry(w, { teacher: String(w.hostel._id) }))).body.code).toBe("WEEK_PLAN_ENTRY_TEACHER");
    expect((await request(app).post(`/api/week-plans/${mine._id}/entries`).send(entry(w))).body.code).toBe("WEEK_PLAN_ENTRY_TEACHER");
    const one = await post(entry(w, { teacher: String(w.noa._id) }));
    expect(one.status).toBe(201);
    expect(one.body.data.view.entries[0]).toMatchObject({ teacher: { _id: String(w.noa._id), firstName: "נועה" }, by: "teacher", byName: "תומר דורון" });
    // the staff correct it, and can hand the lesson to another teacher of the form
    const id = one.body.data.view.entries[0]._id;
    const turned = (await request(app).put(`/api/week-plans/${mine._id}/entries/${id}`).send(entry(w, { teacher: String(w.tomer._id), day: 3 }))).body.data.plan;
    expect(turned.entries[0]).toMatchObject({ day: 3, by: "staff", teacher: { firstName: "תומר" } });
    // "מטי" is a third place, of such a form only
    expect((await post(entry(w, { teacher: String(w.noa._id), day: 4, place: "mati" }))).body.data.view.entries.some((e) => e.place === "mati")).toBe(true);
    expect((await request(app).post(`/api/week-plans/${hers._id}/entries`).send(entry(w, { place: "mati" }))).body.code).toBe("WEEK_PLAN_ENTRY_INVALID");
    // the house becomes two houses: what was written stays, and from now on a lesson is of one of the two
    const before = (await request(app).get(`/api/week-plans`)).body.data.plans.find((p) => p._id === mine._id).entries.length;
    const other = await makeHostel({ name: "אופק", kind: "hostel" });
    expect((await request(app).post(`/api/week-plans/${mine._id}/cover`).send({ teachers: [String(w.noa._id)], hostel: String(w.hostel._id), units: ["1"] })).status).toBe(400);
    const two = (await request(app).post(`/api/week-plans/${mine._id}/cover`).send({ teachers: [String(w.noa._id)], hostel: String(w.hostel._id), units: ["1", "2"] })).body.data.plan;
    expect(two.coversUnits).toEqual(["1", "2"]);
    expect(two.entries).toHaveLength(before);
    expect(two.entries.every((e) => e.unit === "")).toBe(true);
    expect((await request(app).get(`/api/public/week-plans/${token}`)).body.data.view.coversUnits).toEqual(["1", "2"]);
    expect((await post(entry(w, { teacher: String(w.noa._id), day: 2 }))).body.code).toBe("WEEK_PLAN_ENTRY_INVALID");
    expect((await post(entry(w, { teacher: String(w.noa._id), day: 2, unit: "3" }))).body.code).toBe("WEEK_PLAN_ENTRY_INVALID");
    // whatever house is sent, the lesson is of the form's house, and of the unit named
    const placed = (await post(entry(w, { teacher: String(w.noa._id), day: 2, unit: "2", hostel: String(other._id) }))).body.data.view.entries.find((e) => e.day === 2);
    expect(placed).toMatchObject({ unit: "2", hostel: { name: "השלום" } });
    // an old lesson is given its house by one write of the same lesson
    const old = two.entries[0];
    const given = (await request(app).put(`/api/public/week-plans/${token}/entries/${old._id}`).send({ day: old.day, start: old.start, end: old.end, subject: old.subject, place: old.place, teacher: old.teacher._id, unit: "1" })).body.data.view;
    expect(given.entries.find((e) => e._id === old._id)).toMatchObject({ unit: "1", day: old.day, subject: old.subject });
    expect(given.entries).toHaveLength(before + 1);
    // a form of one teacher keeps no teacher on its lessons, whatever is sent
    const plain = (await request(app).post(`/api/week-plans/${hers._id}/entries`).send(entry(w, { teacher: String(w.tomer._id) }))).body.data.plan;
    expect(plain.entries[0].teacher).toBeNull();
    expect(JSON.stringify((await request(app).get("/api/week-plans")).body)).not.toMatch(/"token"/);
  });

  it("the staff say of each lesson whether it is right - and why when it is not; the teacher is never told", async () => {
    // (Eden, 2026-11-25: "לתת לשמרית ולי אפשרות לסמן… מה תקין ומה לא. ואם מסמנים מה לא אז… למה": it belongs to
    // מכללה לכל's program, or something else, said in words)
    const w = await world();
    const plan = (await request(app).post("/api/week-plans").send({ teachers: [String(w.tomer._id)] })).body.data.plans[0];
    const a = (await request(app).post(`/api/week-plans/${plan._id}/entries`).send(entry(w, { day: 0 }))).body.data.plan.entries[0];
    const b = (await request(app).post(`/api/week-plans/${plan._id}/entries`).send(entry(w, { day: 2 }))).body.data.plan.entries.find((e) => e.day === 2);
    expect(a.check).toBeNull();
    const check = (id, body) => request(app).put(`/api/week-plans/${plan._id}/entries/${id}/check`).send(body);
    const of = (r, id) => r.body.data.plan.entries.find((e) => e._id === id).check;

    Object.assign(TEST_ACCOUNT, { name: "שמרית", kind: "hostels" });
    const ok = await check(a._id, { state: "ok" });
    expect(ok.status).toBe(200);
    expect(of(ok, a._id)).toMatchObject({ state: "ok", reason: "", note: "", by: "שמרית" });
    expect(of(ok, b._id)).toBeNull();

    // not right: a reason is needed, and "other" must say what
    for (const bad of [{ state: "bad" }, { state: "bad", reason: "whatever" }, { state: "bad", reason: "other", note: "   " }, { state: "maybe" }]) {
      const r = await check(b._id, bad);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("WEEK_PLAN_CHECK_INVALID");
    }
    expect(of(await check(b._id, { state: "bad", reason: "college" }), b._id)).toMatchObject({ state: "bad", reason: "college", note: "" });
    expect(of(await check(b._id, { state: "bad", reason: "other", note: "  השעה לא נכונה " }), b._id)).toMatchObject({ state: "bad", reason: "other", note: "השעה לא נכונה", by: "שמרית" });

    // the teacher's form holds nothing of it
    const token = (await request(app).get(`/api/week-plans/${plan._id}/link`)).body.data.link.token;
    const view = (await request(app).get(`/api/public/week-plans/${token}`)).body.data.view;
    expect(view.entries).toHaveLength(2);
    expect(JSON.stringify(view)).not.toMatch(/check|השעה לא נכונה|שמרית/);

    // a note beside the lesson leaves the word as it is; the lesson itself changed - nobody looked at it yet
    const noted = await request(app).put(`/api/week-plans/${plan._id}/entries/${a._id}`).send(entry(w, { day: 0, note: "קבוצה ב׳" }));
    expect(of(noted, a._id)).toMatchObject({ state: "ok" });
    const moved = await request(app).put(`/api/week-plans/${plan._id}/entries/${a._id}`).send(entry(w, { day: 0, start: "12:00", end: "13:00" }));
    expect(of(moved, a._id)).toBeNull();
    // taken back
    expect(of(await check(b._id, { state: null }), b._id)).toBeNull();
    expect((await check("64b000000000000000000001", { state: "ok" })).status).toBe(404);

    // the hostels coordinator's and the super admin's alone
    Object.assign(TEST_ACCOUNT, { name: "ייטב", kind: "social" });
    expect((await check(b._id, { state: "ok" })).status).toBe(403);
    Object.assign(TEST_ACCOUNT, { name: "עדן", kind: "super" });
    expect(of(await check(b._id, { state: "ok" }), b._id)).toMatchObject({ state: "ok", by: "עדן" });
  });
});
