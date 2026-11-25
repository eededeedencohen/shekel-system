/**
 * Putting the students and the courses in order (/api/order): the old system's students beside ours as one list, a
 * word about each, who sits in which course, a course that goes, a teacher's free hours - and the journal that keeps
 * what was before and what is after.
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { Person } = require("../../../models/Person");
const { Profile } = require("../../../models/profiles");
const AppSetting = require("../../../models/AppSetting");
const Cycle = require("../../../models/Cycle");
const Enrollment = require("../../../models/Enrollment");
const OrderLog = require("../../../models/OrderLog");
const { makeStudent, makeTeacher, makeSubject, makeCycle, makeEnrollment, makeLesson, makeHostel } = require("../../helpers/factories");
const { createPersonWithProfile } = require("../../../services/profileService");

afterEach(() => {
  TEST_ACCOUNT.kind = "super";
});

const get = async (path = "") => (await request(app).get(`/api/order${path}`)).body.data;
const post = (path, body) => request(app).post(`/api/order${path}`).send(body);
const rowOf = (board, key) => board.rows.find((r) => r.key === key);
const stageOf = async (id) => (await Profile.findOne({ person: id, kind: "StudentCollege" }).lean()).pipeline?.stage;
const running = { startDate: new Date("2026-09-01"), endDate: new Date("2099-06-30"), status: "Active" };

/** The old system's lists, as the ideas page keeps them (the ID numbers inside). */
const oldLists = async ({ students, courses = [], seats = [] }) => {
  await AppSetting.create({ key: "oldStudents", value: { source: "בדיקה", takenAt: "2026-11-25T08:00:00.000Z", rows: students } });
  if (courses.length) await AppSetting.create({ key: "oldCourses", value: { rows: courses } });
  if (seats.length) await AppSetting.create({ key: "oldSeats", value: { rows: seats } });
};
const oldStudent = (rid, name, extra = {}) => ({ rid, name, idNumber: "", phone: "", type: "סטודנט", status: "משובץ-מכללה לכל", residence: "ירושלים", frame: "", ...extra });

describe("putting in order", () => {
  it("is the college managers' and the super admin's; the journal is his alone", async () => {
    for (const kind of ["culture", "hostels", "social"]) {
      TEST_ACCOUNT.kind = kind;
      expect((await request(app).get("/api/order")).status).toBe(403);
      expect((await post("/marks", { key: "s:1", decision: "left" })).status).toBe(403);
    }
    TEST_ACCOUNT.kind = "manager";
    expect((await request(app).get("/api/order")).status).toBe(200);
    expect((await request(app).get("/api/order/log")).status).toBe(403);
    TEST_ACCOUNT.kind = "super";
    expect((await request(app).get("/api/order/log")).status).toBe(200);
  });

  it("lays the college's students of the old system beside ours as one list, and lets no number out", async () => {
    const byNumber = await makeStudent({ firstName: "דנה", lastName: "לוי", phone: "050-1111111" });
    await Person.updateOne({ _id: byNumber._id }, { $set: { idNumber: "123456782" } });
    const byPhone = await makeStudent({ firstName: "יוסי", lastName: "כהן", phone: "052-2222222" });
    const byName = await makeStudent({ firstName: "מיכל", lastName: "אברהם" });
    const alone = await makeStudent({ firstName: "רק", lastName: "אצלנו" });
    const close = await makeStudent({ firstName: "שלומית", lastName: "בן דוד" });
    const { person: culture } = await createPersonWithProfile("StudentCulture", { firstName: "תרבות", lastName: "בלבד" }, { pipelineInit: { stage: "Placed", movedBy: "בדיקה" } });
    const { person: notOurs } = await createPersonWithProfile("StudentCulture", { firstName: "לא", lastName: "מהמכללה" }, { pipelineInit: { stage: "Placed", movedBy: "בדיקה" } });
    await oldLists({
      students: [
        oldStudent("11", "דנה לוי-שם אחר", { idNumber: "123456782" }),
        oldStudent("12", "כהן יוסי", { phone: "+972 52-2222222" }),
        oldStudent("13", "אברהם מיכל"),
        oldStudent("14", "רק בסנזי", { idNumber: "987654321", phone: "054-9999999", status: "מתעניין-מכללה לכל" }),
        oldStudent("15", "שלומית בן דויד"),
        oldStudent("16", "של תרבות בסנזי", { status: "משובץ-תרבות לכל" }),
        oldStudent("17", "בלבד תרבות"),
      ],
      courses: [
        { rid: "900", name: "ציור - רותי - ג` - 10:00 - 11:00", status: "פעיל", start: "01/09/2026", finish: "30/06/2099" },
        { rid: "901", name: "קרמיקה - רותי - ד` - 10:00 - 11:00", status: "הושלם", start: "01/09/2025", finish: "30/06/2026" },
        { rid: "902", name: "מתעניינים במועדון", status: "פעיל", start: "01/09/2026", finish: "30/06/2099" },
      ],
      seats: [
        { rid: "1", course: "900", name: "רק בסנזי", idNumber: "987654321", until: "30/06/2099", weekday: "ג`", time: "10:00", timeEnd: "11:00" },
        { rid: "2", course: "900", name: "אברהם מיכל", idNumber: "", until: "01/01/2026", weekday: "ג`", time: "10:00" },
        { rid: "3", course: "901", name: "רק בסנזי", idNumber: "987654321", until: "30/06/2099" },
        { rid: "4", course: "902", name: "רק בסנזי", idNumber: "987654321", until: "30/06/2099" },
      ],
    });

    const res = await request(app).get("/api/order");
    const board = res.body.data;
    expect(rowOf(board, `p:${byNumber._id}`)).toMatchObject({ how: "id", old: { rid: "11" }, person: { firstName: "דנה", tags: ["college"], former: false } });
    expect(rowOf(board, `p:${byPhone._id}`)).toMatchObject({ how: "phone", old: { rid: "12" } });
    expect(rowOf(board, `p:${byName._id}`)).toMatchObject({ how: "name", old: { rid: "13", courses: [] } });
    expect(rowOf(board, `p:${alone._id}`)).toMatchObject({ old: null, maybe: null });
    // the list is the college's alone: a person of another program is on it only when the old system puts them in the college
    expect(rowOf(board, `p:${culture._id}`)).toMatchObject({ how: "name", old: { rid: "17" }, person: { tags: ["culture"], stage: null } });
    expect(rowOf(board, `p:${notOurs._id}`)).toBeUndefined();
    expect(rowOf(board, "s:16")).toBeUndefined();
    // only in the old system: its status, and the one course that still runs there (not the one that ended, not the list)
    expect(rowOf(board, "s:14")).toMatchObject({ person: null, old: { status: "מתעניין-מכללה לכל", courses: [{ name: "ציור - רותי - ג` - 10:00 - 11:00", time: "10:00-11:00" }] } });
    // a name a letter away: two lines, each pointing at the other
    expect(rowOf(board, `p:${close._id}`)).toMatchObject({ old: null, maybe: { key: "s:15", why: "nameClose" } });
    expect(rowOf(board, "s:15")).toMatchObject({ person: null, maybe: { key: `p:${close._id}` } });
    expect(board.rows).toHaveLength(8);
    expect(board.old).toMatchObject({ count: 7 });
    // no ID number and no phone of either list in the answer
    for (const secret of ["123456782", "987654321", "1111111", "2222222", "9999999", "idNumber", '"phone":']) expect(res.text).not.toContain(secret);
  });

  it("keeps a word about a person, and every change of it with its before and after", async () => {
    const p = await makeStudent({ firstName: "נועם", lastName: "שלם" });
    await oldLists({ students: [oldStudent("21", "רק שם")] });
    const key = `p:${p._id}`;
    expect((await post("/marks", { key, decision: "nothing" })).body.code).toBe("ORDER_INVALID");
    expect((await post("/marks", { key: "p:000000000000000000000000", decision: "left" })).status).toBe(404);
    expect((await post("/marks", { key: "s:999", decision: "left" })).status).toBe(404);
    expect((await post("/marks", { key, decision: "other", note: "  " })).body.code).toBe("ORDER_NOTE_NEEDED");

    expect((await post("/marks", { key, decision: "college" })).body.data.mark).toMatchObject({ decision: "college", by: "בדיקות" });
    await post("/marks", { key, decision: "college" }); // said again: nothing new to write down
    await post("/marks", { key, decision: "other", note: "עבר לתל אביב, חוזר בקיץ" });
    await post("/marks", { key: "s:21", decision: "left" });
    let board = await get();
    expect(rowOf(board, key).mark).toMatchObject({ decision: "other", note: "עבר לתל אביב, חוזר בקיץ" });
    expect(rowOf(board, "s:21").mark).toMatchObject({ decision: "left" });
    await post("/marks", { key, decision: null });
    board = await get();
    expect(rowOf(board, key).mark).toBeNull();

    const { entries } = await get("/log");
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.kind === "mark" && e.by === "בדיקות" && !("raw" in e))).toBe(true);
    const [off, left, other, college] = entries;
    expect(college).toMatchObject({ personName: "נועם שלם", before: ["בלי סימון"], after: ["סימון: שייך/ת למכללה לכל"] });
    expect(other).toMatchObject({ before: ["סימון: שייך/ת למכללה לכל"], after: ["סימון: אחר", "ההערה: עבר לתל אביב, חוזר בקיץ"] });
    expect(left).toMatchObject({ personName: "רק שם", rid: "21", after: ["סימון: עזב/ה את שק״ל"] });
    expect(off).toMatchObject({ text: "הסימון הוסר", after: ["בלי סימון"] });
    // a word only: the person still holds the college, as before
    expect(rowOf(board, key).person).toMatchObject({ tags: ["college"], former: false });
  });

  it("joins two lines the staff called one person, and parts two it called two", async () => {
    const a = await makeStudent({ firstName: "אביגיל", lastName: "הר זהב" });
    const b = await makeStudent({ firstName: "תמר", lastName: "רוזנברג" });
    await oldLists({ students: [oldStudent("31", "אביגיל הר-זהב כהן"), oldStudent("32", "תמר רוזנברק")] });
    let board = await get();
    expect(rowOf(board, "s:32").maybe).toMatchObject({ key: `p:${b._id}` });
    await post("/marks", { key: "s:31", decision: "left" });

    expect((await post("/links", { rid: "31", person: String(a._id), same: true })).body.data).toEqual({ same: true });
    expect((await post("/links", { rid: "32", person: String(b._id), same: false })).status).toBe(200);
    board = await get();
    // one line now, and the word said of the old row came along
    expect(rowOf(board, `p:${a._id}`)).toMatchObject({ how: "link", old: { rid: "31" }, mark: { decision: "left" } });
    expect(rowOf(board, "s:31")).toBeUndefined();
    expect(rowOf(board, "s:32").maybe).toBeNull();
    expect(rowOf(board, `p:${b._id}`).maybe).toBeNull();
    const { entries } = await get("/log");
    expect(entries.filter((e) => e.kind === "link").map((e) => e.after[0]).sort()).toEqual(["אותו אדם", "שני אנשים"]);
  });

  it("takes a person off a course by the app's own rule, and brings them back", async () => {
    const teacher = await makeTeacher({ firstName: "רותי", lastName: "מורה" });
    const subject = await makeSubject({ name: "ציור" });
    const cycle = await makeCycle({ subject: subject._id, teacher: teacher._id, ...running, schedule: [{ day: 2, start: "10:00", end: "11:00" }] });
    const p = await makeStudent({ firstName: "אורי", lastName: "יושב" });
    const seat = await makeEnrollment({ cycle: cycle._id, student: p._id });
    await p.moveToStage("Placed", "בדיקה");

    let board = await get();
    expect(board.courses.find((c) => c._id === String(cycle._id))).toMatchObject({ name: "ציור", teacher: { name: "רותי מורה" }, slots: [{ day: 2, start: "10:00", end: "11:00" }], seats: [{ id: String(seat._id), name: "אורי יושב", status: "active" }] });

    const off = await post("/seats/off", { enrollment: String(seat._id) });
    expect(off.body.data).toMatchObject({ seat: { status: "left" }, stage: "NeedsReplacement" });
    expect((await Enrollment.findById(seat._id).lean()).status).toBe("left");
    expect((await post("/seats/off", { enrollment: String(seat._id) })).body.code).toBe("ORDER_SEAT_GONE");
    board = await get();
    expect(board.courses.find((c) => c._id === String(cycle._id)).seats).toEqual([]);

    const on = await post("/seats/on", { cycle: String(cycle._id), student: String(p._id) });
    expect(on.body.data).toMatchObject({ seat: { id: String(seat._id), status: "active", name: "אורי יושב" }, stage: "Placed" });
    // someone who is not of the college cannot be seated in its course
    const { person: culture } = await createPersonWithProfile("StudentCulture", { firstName: "תרבות", lastName: "בלבד" }, { pipelineInit: { stage: "Placed", movedBy: "בדיקה" } });
    expect((await post("/seats/on", { cycle: String(cycle._id), student: String(culture._id) })).body.code).toBe("NOT_IN_PROGRAM");

    const { entries } = await get("/log");
    expect(entries.map((e) => e.kind)).toEqual(["seatOn", "seatOff"]);
    expect(entries[1]).toMatchObject({ personName: "אורי יושב", cycleName: "ציור", text: "ירידה מהקורס ציור" });
    expect(entries[1].before).toEqual(expect.arrayContaining(["השלב במכללה לכל: משובץ"]));
    expect(entries[1].before[0]).toContain("המורה רותי מורה · יום ג׳ 10:00-11:00");
    expect(entries[1].after).toEqual(expect.arrayContaining(["השלב במכללה לכל: דרוש שיבוץ מחדש"]));
    expect((await OrderLog.findOne({ kind: "seatOff" }).lean()).raw.enrollment.status).toBe("active");
  });

  it("keeps a college manager away from a hostel's course", async () => {
    const hostel = await makeHostel();
    const cycle = await makeCycle({ hostel: hostel._id, ...running });
    const p = await makeStudent();
    const seat = await makeEnrollment({ cycle: cycle._id, student: p._id });
    expect((await get()).courses.map((c) => c._id)).toContain(String(cycle._id));
    expect((await request(app).delete(`/api/order/courses/${cycle._id}`)).body.code).toBe("ORDER_COLLEGE_ONLY");
    TEST_ACCOUNT.kind = "manager";
    expect((await get()).courses).toEqual([]);
    expect((await post("/seats/off", { enrollment: String(seat._id) })).status).toBe(403);
    expect((await request(app).delete(`/api/order/courses/${cycle._id}`)).status).toBe(403);
    expect((await Enrollment.findById(seat._id).lean()).status).toBe("active");
  });

  it("deletes a course nothing leans on, with its seats, and keeps all of it in the journal", async () => {
    const teacher = await makeTeacher({ firstName: "דן", lastName: "מלמד", availability: [{ day: 1, start: "09:00", end: "10:00", program: "college" }, { day: 3, start: "12:00", end: "14:00", program: "hostels" }] });
    const subject = await makeSubject({ name: "גיטרה" });
    const cycle = await makeCycle({ subject: subject._id, teacher: teacher._id, ...running, schedule: [{ day: 1, start: "10:00", end: "11:00" }, { day: 3, start: "13:00", end: "14:00" }] });
    const other = await makeCycle({ ...running });
    const [a, b] = [await makeStudent({ firstName: "אחת", lastName: "בקורס" }), await makeStudent({ firstName: "שני", lastName: "בשניים" })];
    await makeEnrollment({ cycle: cycle._id, student: a._id });
    await makeEnrollment({ cycle: cycle._id, student: b._id });
    await makeEnrollment({ cycle: other._id, student: b._id });
    await a.moveToStage("Placed", "בדיקה");
    await b.moveToStage("Placed", "בדיקה");

    const res = await request(app).delete(`/api/order/courses/${cycle._id}`).send({ toWindow: true });
    expect(res.body.data).toMatchObject({ done: "deleted", moves: [{ name: "אחת בקורס", from: "Placed", to: "NeedsReplacement" }] });
    expect(await Cycle.findById(cycle._id)).toBeNull();
    expect(await Enrollment.countDocuments({ cycle: cycle._id })).toBe(0);
    expect(await Enrollment.countDocuments({ cycle: other._id })).toBe(1);
    expect(await stageOf(b._id)).toBe("Placed"); // still sits in another course
    // the course's hours are now hours the teacher is free: one joined the window it touched, one is the hostels' and was left
    const windows = (await Person.findById(teacher._id).lean()).availability.map((w) => `${w.day} ${w.start}-${w.end} ${w.program}`);
    expect(windows.sort()).toEqual(["1 09:00-11:00 college", "3 12:00-14:00 hostels"]);
    expect(res.body.data.windows).toHaveLength(2);

    const log = await OrderLog.findOne({ kind: "courseOff" }).lean();
    expect(log).toMatchObject({ text: "הקורס גיטרה נמחק", cycleName: "גיטרה", personName: "דן מלמד" });
    expect(log.before[2]).toBe("2 סטודנטים בקורס: אחת בקורס, שני בשניים");
    expect(log.after).toEqual(expect.arrayContaining(["הקורס נמחק", "אחת בקורס: משובץ ← דרוש שיבוץ מחדש", "יום ד׳ 13:00-14:00: לא סומן, השעה שמורה להוסטלים"]));
    expect(log.raw.cycle._id).toEqual(cycle._id);
    expect(log.raw.enrollments).toHaveLength(2);
    expect(log.raw.enrollments.every((e) => e.status === "active")).toBe(true);
  });

  it("closes, and does not delete, a course that attendance still leans on", async () => {
    const cycle = await makeCycle({ ...running });
    const p = await makeStudent();
    const seat = await makeEnrollment({ cycle: cycle._id, student: p._id });
    await makeLesson({ cycle: cycle._id });
    expect((await get()).courses[0].leans).toMatchObject({ lessons: 1 });
    const res = await request(app).delete(`/api/order/courses/${cycle._id}`);
    expect(res.body.data).toMatchObject({ done: "closed" });
    const kept = await Cycle.findById(cycle._id).lean();
    expect(kept.status).toBe("Cancelled");
    expect(new Date(kept.endDate).getTime()).toBeLessThan(Date.now());
    expect((await Enrollment.findById(seat._id).lean()).status).toBe("left");
    expect((await get()).courses).toEqual([]);
    expect((await OrderLog.findOne({ kind: "courseOff" }).lean()).after[0]).toContain("הקורס נסגר");
  });

  it("writes a teacher's free hours by the teacher page's rules", async () => {
    const teacher = await makeTeacher({ firstName: "גל", lastName: "פנויה", availability: [{ day: 0, start: "09:00", end: "12:00", program: "hostels" }] });
    const student = await makeStudent();
    const put = (id, availability) => request(app).put(`/api/order/teachers/${id}/windows`).send({ availability });
    expect((await put(String(student._id), [])).status).toBe(404);
    expect((await get()).teachers.find((t) => t._id === String(teacher._id))).toMatchObject({ name: "גל פנויה", windows: [{ day: 0, start: "09:00", end: "12:00", program: "hostels" }] });

    TEST_ACCOUNT.kind = "manager";
    // the hostels' window is not the college's to drop
    expect((await put(String(teacher._id), [{ day: 2, start: "13:00", end: "15:00", program: "college" }])).body.code).toBe("AVAILABILITY_LOCKED");
    const ok = await put(String(teacher._id), [{ day: 0, start: "09:00", end: "12:00", program: "hostels" }, { day: 2, start: "13:00", end: "15:00", program: "college" }]);
    expect(ok.body.data.windows).toHaveLength(2);
    TEST_ACCOUNT.kind = "super";
    const { entries } = await get("/log");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "windows", personName: "גל פנויה", before: ["יום א׳ 09:00-12:00 · הוסטלים"], after: ["יום א׳ 09:00-12:00 · הוסטלים", "יום ג׳ 13:00-15:00 · מכללה לכל"] });
  });
});
