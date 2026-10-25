/**
 * Phase 3 of שמרית's round (her answers of 2026-10-19): the house's
 * attendance draft behind a monthly link - held or not, who came, why
 * someone did not, someone not on the list, someone who left - and the
 * coordinator's approval that makes it attendance; the absence reason on
 * the attendance itself; the Ministry of Health's monthly Excel; the
 * invoices' due day and the teacher's rate on the round.
 */

const request = require("supertest");
const app = require("../../../app");
const Hostel = require("../../../models/Hostel");
const HostelReport = require("../../../models/HostelReport");
const Cycle = require("../../../models/Cycle");
const Lesson = require("../../../models/Lesson");
const Enrollment = require("../../../models/Enrollment");
const { Person } = require("../../../models/Person");
const { Profile } = require("../../../models/profiles");
const tags = require("../../../services/tagService");
const { makeTeacher, makeStudent, makeHostel, makeCycle, makeSubject } = require("../../helpers/factories");

/** A hostel with a reporter, a course live last month and this one (Mondays 10:00), three residents seated; a קהילה with a course too. */
async function houseMonth() {
  const hostel = await makeHostel({ name: "השיירות", kind: "hostel", approvals: 15, since: new Date("2022-06-01"), contacts: [{ name: "גילי", role: "reporter", phone: "052-4725545" }] });
  const community = await makeHostel({ name: "בית אחווה", kind: "community" });
  const subject = await makeSubject({ name: "כלבנות" });
  const teacher = await makeTeacher({ firstName: "תומר", lastName: "דורון" });
  const cycle = await makeCycle({ subject: subject._id, teacher: teacher._id, hostel: hostel._id, startDate: new Date("2026-01-01"), endDate: new Date("2027-07-31"), schedule: [{ day: 1, start: "10:00", end: "11:00" }] });
  await tags.setCycleProgram({ cycleId: cycle._id, key: "hostels" });
  const c2 = await makeCycle({ teacher: teacher._id, hostel: community._id, startDate: new Date("2026-01-01"), endDate: new Date("2027-07-31"), schedule: [{ day: 3, start: "17:00", end: "18:00" }] });
  await tags.setCycleProgram({ cycleId: c2._id, key: "hostels" });
  const residents = [];
  for (const [f, l] of [["ליטבין", "סבטלנה"], ["אסתר", "כהן"], ["ניצה", "פרסי"]]) {
    const s = await makeStudent({ firstName: f, lastName: l, residence: { hostel: hostel._id, since: new Date("2026-01-01") } });
    await tags.give({ personId: s._id, key: "hostels" });
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: s._id });
    residents.push(s);
  }
  return { hostel, community, cycle, c2, teacher, residents };
}

/** Last month's key, "YYYY-MM" - its sessions all lie in the past. */
function lastMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

describe("the hostel's attendance draft", () => {
  it("opens a month for every house with a course: a link per house with the planned sessions and the reporter; twice adds nothing", async () => {
    const { hostel, community } = await houseMonth();
    const month = lastMonth();
    const res = await request(app).post("/api/hostel-reports").send({ month });
    expect(res.status).toBe(201);
    const list = res.body.data.reports;
    expect(list.map((r) => r.hostel.name).sort()).toEqual(["בית אחווה", "השיירות"]);
    const r = list.find((x) => String(x.hostel._id) === String(hostel._id));
    expect(r).toMatchObject({ month, status: "new", contact: { name: "גילי", phone: "052-4725545" } });
    expect(r.hostel.title).toBe("הוסטל השיירות");
    expect(r.sessions.length).toBeGreaterThanOrEqual(4);
    expect(r.sessions.every((s) => new Date(s.date).getUTCDay() === 1)).toBe(true);
    expect(r.counts.unmarked).toBe(r.sessions.length);
    expect(list.find((x) => String(x.hostel._id) === String(community._id)).hostel.title).toBe("קהילת בית אחווה");

    const again = await request(app).post("/api/hostel-reports").send({ month });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("HOSTEL_REPORT_NO_COURSES");
    const one = await request(app).post("/api/hostel-reports").send({ month, hostel: hostel._id });
    expect(one.body.code).toBe("HOSTEL_REPORT_EXISTS");
    expect((await request(app).post("/api/hostel-reports").send({ month: "13/2026" })).body.code).toBe("HOSTEL_REPORT_MONTH");
    expect((await request(app).get("/api/hostel-reports")).body.data.reports).toHaveLength(2);
  });

  it("the house behind the link marks a session with reasons, adds someone, notes who left, finishes; the coordinator approves into the attendance", async () => {
    const { hostel, cycle, residents } = await houseMonth();
    const month = lastMonth();
    const opened = (await request(app).post("/api/hostel-reports").send({ month, hostel: hostel._id })).body.data.reports[0];
    await request(app).post(`/api/hostel-reports/${opened._id}/sent`).send({});

    const url = `/api/public/hostel-reports/${opened.token}`;
    const view = (await request(app).get(url)).body.data.view;
    expect(view).toMatchObject({ month, done: false, contact: "גילי" });
    expect(view.hostel.title).toBe("הוסטל השיירות");
    expect(view.courses).toHaveLength(1);
    expect(view.courses[0].roster.map((p) => p.name)).toEqual(["אסתר כהן", "ליטבין סבטלנה", "ניצה פרסי"]);
    expect(view.reasons.map((r) => r.key)).toContain("hospital");
    expect((await request(app).get(`/api/hostel-reports/${opened._id}`)).body.data.report.status).toBe("opened");

    const [s1, s2] = view.courses[0].sessions;
    const [a, b, c] = residents;
    // an absent one without a reason is refused
    const noReason = await request(app).put(`${url}/sessions/${s1._id}`).send({ state: "held", marks: [{ person: a._id, status: "present" }, { person: b._id, status: "absent" }] });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe("HOSTEL_REPORT_REASON_REQUIRED");
    const stranger = await makeStudent();
    const notListed = await request(app).put(`${url}/sessions/${s1._id}`).send({ state: "held", marks: [{ person: stranger._id, status: "present" }] });
    expect(notListed.body.code).toBe("HOSTEL_REPORT_NOT_IN_LIST");
    const marked = await request(app).put(`${url}/sessions/${s1._id}`).send({ state: "held", marks: [{ person: a._id, status: "present" }, { person: b._id, status: "absent", reason: "hospital", note: "בהדסה" }, { person: c._id, status: "absent", reason: "refused" }] });
    expect(marked.status).toBe(200);
    expect(marked.body.data.view.courses[0].sessions[0]).toMatchObject({ state: "held", present: 1, absent: 2 });
    const notHeld = await request(app).put(`${url}/sessions/${s2._id}`).send({ state: "notHeld" });
    expect(notHeld.body.data.view.counts).toMatchObject({ held: 1, notHeld: 1 });

    const extra = await request(app).post(`${url}/extras`).send({ name: "דייר חדש", cycle: String(cycle._id), note: "הגיע לראשונה" });
    expect(extra.body.data.view.extras).toHaveLength(1);
    expect((await request(app).post(`${url}/extras`).send({ name: " " })).body.code).toBe("HOSTEL_REPORT_EXTRA_NAME");
    const left = await request(app).post(`${url}/left`).send({ person: c._id, date: `${month}-15`, note: "עבר לדיור עצמאי" });
    expect(left.body.data.view.left).toHaveLength(1);
    expect(left.body.data.view.courses[0].roster.find((p) => String(p._id) === String(c._id)).left).toBe(true);

    const done = await request(app).post(`${url}/done`).send({ note: "חג בשבוע השני" });
    expect(done.body.data.view.done).toBe(true);
    expect((await request(app).put(`${url}/sessions/${s1._id}`).send({ state: "held", marks: [] })).body.code).toBe("HOSTEL_REPORT_DONE");

    // the coordinator's side
    let staff = (await request(app).get(`/api/hostel-reports/${opened._id}`)).body.data.report;
    expect(staff).toMatchObject({ status: "done", note: "חג בשבוע השני" });
    expect(staff.counts).toMatchObject({ held: 1, notHeld: 1, toApprove: 2, approved: 0, present: 1, absent: 2, extras: 1, left: 1 });
    expect(staff.sessions[0].marks.find((m) => m.person.name === "אסתר כהן")).toMatchObject({ status: "absent", reason: "hospital", reasonLabel: "אשפוז", note: "בהדסה" });
    expect(staff.sessions[0].marks.find((m) => m.person.name === "ליטבין סבטלנה")).toMatchObject({ status: "present", reason: null });

    const approved = await request(app).post(`/api/hostel-reports/${opened._id}/sessions/${s1._id}/approve`).send({});
    expect(approved.status).toBe(200);
    const lesson = await Lesson.findOne({ cycle: cycle._id, date: new Date(s1.date) });
    expect(lesson).toBeTruthy();
    const rows = Object.fromEntries(lesson.attendance.map((x) => [String(x.student), x]));
    expect(rows[String(a._id)].status).toBe("Present");
    expect(rows[String(b._id)]).toMatchObject({ status: "Missing", reason: "hospital", note: "בהדסה" });
    expect(rows[String(c._id)]).toMatchObject({ status: "Missing", reason: "refused" });
    expect((await request(app).post(`/api/hostel-reports/${opened._id}/sessions/${s1._id}/approve`).send({})).body.code).toBe("HOSTEL_REPORT_APPROVED");
    const all = (await request(app).post(`/api/hostel-reports/${opened._id}/approve`).send({})).body.data.report;
    expect(all.status).toBe("approved");
    expect(all.counts).toMatchObject({ approved: 2, toApprove: 0 });
    expect(await Lesson.countDocuments({ cycle: cycle._id })).toBe(1); // a session not held leaves no lesson

    // the new resident: a person of ours, living here, in the program, seated in the course
    const x = all.extras[0];
    const resolved = (await request(app).post(`/api/hostel-reports/${opened._id}/extras/${x._id}/resolve`).send({ firstName: "דייר", lastName: "חדש", gender: "male" })).body.data.report;
    expect(resolved.extras[0].resolvedAt).toBeTruthy();
    const newcomer = await Person.findById(resolved.extras[0].person._id);
    expect(newcomer.firstName).toBe("דייר");
    expect(await tags.holds(newcomer._id, "hostels")).toBe(true);
    expect(await tags.holds(newcomer._id, "college")).toBe(false);
    const prof = await Profile.findOne({ person: newcomer._id, kind: "StudentCollege" });
    expect(String(prof.residence.hostel)).toBe(String(hostel._id));
    expect(await Enrollment.exists({ cycle: cycle._id, student: newcomer._id, status: "active" })).toBeTruthy();
    expect((await request(app).post(`/api/hostel-reports/${opened._id}/extras/${x._id}/resolve`).send({ firstName: "שוב" })).body.code).toBe("HOSTEL_REPORT_RESOLVED");

    // the leaver: the residence closes on the day the house said, the seat ends
    const l = all.left[0];
    const gone = (await request(app).post(`/api/hostel-reports/${opened._id}/left/${l._id}/resolve`).send({})).body.data.report;
    expect(gone.left[0].resolvedAt).toBeTruthy();
    const cProf = await Profile.findOne({ person: c._id, kind: "StudentCollege" });
    expect(cProf.residence.until.toISOString().slice(0, 10)).toBe(`${month}-15`);
    expect((await Enrollment.findOne({ cycle: cycle._id, student: c._id })).status).toBe("left");

    // approved sessions keep the report
    expect((await request(app).delete(`/api/hostel-reports/${opened._id}`)).body.code).toBe("HOSTEL_REPORT_HAS_APPROVED");
  });

  it("a session is marked only once its day came; an unknown or expired link answers so; an empty month can be deleted", async () => {
    const { hostel } = await houseMonth();
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const opened = (await request(app).post("/api/hostel-reports").send({ month: thisMonth, hostel: hostel._id })).body.data.reports[0];
    const url = `/api/public/hostel-reports/${opened.token}`;
    const view = (await request(app).get(url)).body.data.view;
    const future = view.courses[0].sessions.find((s) => s.future);
    if (future) {
      const res = await request(app).put(`${url}/sessions/${future._id}`).send({ state: "held", marks: [] });
      expect(res.body.code).toBe("HOSTEL_REPORT_SESSION_FUTURE");
    }
    expect((await request(app).get("/api/public/hostel-reports/not-a-real-token-at-all")).status).toBe(404);
    await HostelReport.updateOne({ _id: opened._id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await request(app).get(url)).status).toBe(410);
    const renewed = await request(app).post(`/api/hostel-reports/${opened._id}/renew`).send({ days: 7 });
    expect(renewed.body.data.report.linkLive).toBe(true);
    expect((await request(app).delete(`/api/hostel-reports/${opened._id}`)).status).toBe(204);
    expect(await HostelReport.countDocuments()).toBe(0);
  });

  it("the draft follows the house's courses: a course added or a time moved after the month was opened shows up on the next read; a marked session stays", async () => {
    const { hostel, cycle, teacher, residents } = await houseMonth();
    const month = lastMonth();
    const opened = (await request(app).post("/api/hostel-reports").send({ month, hostel: hostel._id })).body.data.reports[0];
    const url = `/api/public/hostel-reports/${opened.token}`;
    const mondays = opened.sessions.length;
    expect(opened.sessions.every((s) => new Date(s.date).getUTCDay() === 1)).toBe(true);
    const first = opened.sessions[0];
    await request(app).put(`${url}/sessions/${first._id}`).send({ state: "held", marks: [{ person: residents[0]._id, status: "present" }] });

    // after the opening: a second course on Thursdays, and the first course moves to Tuesdays (as her table did to יוגה at אופק)
    const extra = await makeCycle({ teacher: teacher._id, hostel: hostel._id, startDate: new Date("2026-01-01"), endDate: new Date("2027-07-31"), schedule: [{ day: 4, start: "14:00", end: "15:00" }] });
    await tags.setCycleProgram({ cycleId: extra._id, key: "hostels" });
    await Cycle.updateOne({ _id: cycle._id }, { schedule: [{ day: 2, start: "10:00", end: "11:00" }] });

    const report = (await request(app).get(`/api/hostel-reports/${opened._id}`)).body.data.report;
    const ofFirst = report.sessions.filter((s) => String(s.cycle._id) === String(cycle._id));
    const ofExtra = report.sessions.filter((s) => String(s.cycle._id) === String(extra._id));
    expect(ofExtra.length).toBeGreaterThanOrEqual(4);
    expect(ofExtra.every((s) => new Date(s.date).getUTCDay() === 4)).toBe(true);
    // the marked Monday stays with its word; the other Mondays gave way to Tuesdays
    const kept = ofFirst.find((s) => String(s._id) === String(first._id));
    expect(kept).toMatchObject({ state: "held", present: 1 });
    expect(ofFirst.filter((s) => new Date(s.date).getUTCDay() === 1)).toHaveLength(1);
    expect(ofFirst.filter((s) => new Date(s.date).getUTCDay() === 2).length).toBeGreaterThanOrEqual(4);
    expect(ofFirst.length).toBeGreaterThanOrEqual(mondays);
    // the house's own page reads the same two courses; the list too
    const view = (await request(app).get(url)).body.data.view;
    expect(view.courses).toHaveLength(2);
    expect((await request(app).get("/api/hostel-reports")).body.data.reports[0].sessions).toHaveLength(report.sessions.length);
    // once the house pressed סיימתי the draft is frozen
    await request(app).post(`${url}/done`).send({});
    await Cycle.updateOne({ _id: extra._id }, { schedule: [{ day: 5, start: "14:00", end: "15:00" }] });
    expect((await request(app).get(`/api/hostel-reports/${opened._id}`)).body.data.report.sessions).toHaveLength(report.sessions.length);
  });
});

describe("the absence reason on the attendance itself", () => {
  it("rides on the grid and the single cell; an unknown one is refused", async () => {
    const teacher = await makeTeacher();
    const cycle = await makeCycle({ teacher: teacher._id });
    const s = await makeStudent();
    const res = await request(app).put("/api/lessons/attendance").send({ cycle: cycle._id, date: "2026-03-03", records: [{ student: s._id, status: "Missing", reason: "vacation", note: "בצפון" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.lesson.attendance[0]).toMatchObject({ status: "Missing", reason: "vacation", note: "בצפון" });
    const bad = await request(app).put("/api/lessons/attendance").send({ cycle: cycle._id, date: "2026-03-03", records: [{ student: s._id, status: "Missing", reason: "lazy" }] });
    expect(bad.body.code).toBe("ATTENDANCE_REASON_INVALID");
    const id = res.body.data.lesson._id;
    const cell = await request(app).patch(`/api/lessons/${id}/attendance/${s._id}`).send({ status: "Present", reason: null });
    expect(cell.body.data.lesson.attendance[0]).toMatchObject({ status: "Present", reason: null });
  });
});

describe("the Ministry of Health's month", () => {
  it("lists the hostels alone with their courses, approvals, start and the average attendance; the Excel downloads", async () => {
    const { hostel, cycle, residents } = await houseMonth();
    const month = lastMonth();
    const [y, m] = month.split("-").map(Number);
    await Lesson.create({ cycle: cycle._id, date: new Date(Date.UTC(y, m - 1, 7)), attendance: residents.map((s, i) => ({ student: s._id, status: i === 0 ? "Missing" : "Present", reason: i === 0 ? "er" : null })) });
    await Lesson.create({ cycle: cycle._id, date: new Date(Date.UTC(y, m - 1, 14)), attendance: residents.map((s) => ({ student: s._id, status: "Present" })) });
    await Hostel.create({ name: "לא פעיל", active: false });
    // a house that is a hostel AND holds a supportive community (her "מצפה רעות הוסטל וקהילה תומכת") is a hostel for the Ministry
    const mixed = await makeHostel({ name: "מצפה רעות", kind: "both", approvals: 12 });
    const c3 = await makeCycle({ hostel: mixed._id, startDate: new Date("2026-01-01"), endDate: new Date("2027-07-31"), schedule: [{ day: 0, start: "16:00", end: "17:00" }] });
    await tags.setCycleProgram({ cycleId: c3._id, key: "hostels" });
    expect((await request(app).put(`/api/hostels/${mixed._id}`).send({ kind: "wizard" })).body.code).toBe("HOSTEL_KIND_INVALID");
    const res = await request(app).get(`/api/hostel-reports/ministry?month=${month}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.rows;
    expect(rows.map((r) => r.hostel.name)).toEqual(["השיירות", "מצפה רעות"]); // the קהילה and the inactive house are out
    expect(rows[1].hostel).toMatchObject({ kind: "both", title: "הוסטל מצפה רעות" });
    expect(rows[0]).toMatchObject({ approvals: 15, sinceLabel: "מעל 4 שנים" });
    expect(rows[0].courses).toHaveLength(1);
    expect(rows[0].courses[0]).toMatchObject({ name: "כלבנות", teacher: "תומר דורון", lessons: 2, avg: 3 }); // (2 + 3) / 2 = 2.5 → 3
    const xlsx = await request(app).get(`/api/hostel-reports/ministry.xlsx?month=${month}`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-type"]).toMatch(/spreadsheetml/);
    expect(xlsx.headers["content-disposition"]).toMatch(/attachment/);
    expect(Number(xlsx.headers["content-length"])).toBeGreaterThan(1000);
  });
});

describe("the invoice round carries the due day and the teacher's rate", () => {
  it("the 29th of the month; ₪ per session from the Teacher profile", async () => {
    const { teacher } = await houseMonth();
    await Profile.updateOne({ person: teacher._id, kind: "Teacher" }, { hostelRate: 350 });
    const month = lastMonth();
    const round = (await request(app).post("/api/invoice-rounds").send({ month, program: "hostels" })).body.data.round;
    expect(round.dueAt.slice(0, 10)).toBe(`${month}-29`);
    expect(round.requests[0].teacher.rate).toBe(350);
    const view = (await request(app).get(`/api/public/invoices/${round.requests[0].token}`)).body.data.view;
    expect(view.dueAt.slice(0, 10)).toBe(`${month}-29`);
  });
});
