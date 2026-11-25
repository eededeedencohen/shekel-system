/**
 * The students' tags plan (Eden, 2026-11-24: "עמוד שרק לי תהיה אפשרות
 * לראות שבו אנחנו מנהלים את הדברים האלה"): the super admin's answers to the
 * plan's open questions and his notes are kept in one row, his alone to
 * read and to write.
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const AuditEvent = require("../../../models/AuditEvent");

afterEach(() => {
  TEST_ACCOUNT.kind = "super";
});

const get = () => request(app).get("/api/tag-plan");
const put = (body) => request(app).put("/api/tag-plan").send(body);

describe("the students' tags plan", () => {
  it("is empty at first", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.data.plan.answers).toEqual({});
    expect(r.body.data.plan.notes).toEqual({});
  });

  it("keeps an answer and a note, changes one without touching the other, and takes them back", async () => {
    const a = await put({ answers: { member: "course" }, notes: { "case:college:lead": "  לבדוק עם ייטב  " } });
    expect(a.status).toBe(200);
    expect(a.body.data.plan.answers).toEqual({ member: "course" });
    expect(a.body.data.plan.notes).toEqual({ "case:college:lead": "לבדוק עם ייטב" });

    const b = await put({ answers: { others: "all" } });
    expect(b.body.data.plan.answers).toEqual({ member: "course", others: "all" });
    expect(b.body.data.plan.notes).toEqual({ "case:college:lead": "לבדוק עם ייטב" });

    const c = await put({ answers: { member: null }, notes: { "case:college:lead": "" } });
    expect(c.body.data.plan.answers).toEqual({ others: "all" });
    expect(c.body.data.plan.notes).toEqual({});
    expect((await get()).body.data.plan.answers).toEqual({ others: "all" });
  });

  it("is the super admin's alone, to read and to write", async () => {
    await put({ answers: { member: "course" } });
    for (const kind of ["social", "manager", "culture", "hostels"]) {
      TEST_ACCOUNT.kind = kind;
      expect((await get()).status).toBe(403);
      expect((await put({ answers: { member: "intake" } })).status).toBe(403);
    }
    TEST_ACCOUNT.kind = "super";
    expect((await get()).body.data.plan.answers.member).toBe("course");
  });

  it("keeps the old sheet's waiting lists for the model: the super admin's alone, out of the audit, and taken off again", async () => {
    const sheet = () => request(app).get("/api/tag-plan/sheet");
    expect((await sheet()).body.data.sheet).toBeNull();
    const body = { title: "רשימות המתנה", lists: [{ subject: "  מוסיקה ", waiting: [{ name: " דנה   בדיקה ", note: "גיטרה" }, { name: "יואב בדיקה" }], existing: [{ name: "רון בדיקה", note: "" }] }, { subject: "ערבית", waiting: [] }] };
    const put = await request(app).put("/api/tag-plan/sheet").send(body);
    expect(put.status).toBe(200);
    expect(put.body.data.sheet.lists).toEqual([
      { subject: "מוסיקה", waiting: [{ name: "דנה בדיקה", note: "גיטרה" }, { name: "יואב בדיקה", note: "" }], existing: [{ name: "רון בדיקה", note: "" }] },
      { subject: "ערבית", waiting: [], existing: [] },
    ]);
    expect((await sheet()).body.data.sheet.lists).toHaveLength(2);
    // the answers' row is another row: untouched
    expect((await get()).body.data.plan.notes).toEqual({});

    // nobody else reads or writes it
    TEST_ACCOUNT.kind = "manager";
    expect((await sheet()).status).toBe(403);
    expect((await request(app).put("/api/tag-plan/sheet").send(body)).status).toBe(403);
    expect((await request(app).delete("/api/tag-plan/sheet")).status).toBe(403);
    TEST_ACCOUNT.kind = "super";

    // no name of it rides into the audit (the audit is written after the answer - give it a moment)
    await new Promise((r) => setTimeout(r, 300));
    const events = await AuditEvent.find({}).lean();
    expect(JSON.stringify(events)).not.toContain("דנה");

    // what is not a sheet is refused
    for (const bad of [{}, { lists: [] }, { lists: [{ subject: "" }] }, { lists: [{ subject: "ציור", waiting: [{ note: "בלי שם" }] }] }, { lists: [{ subject: "ציור", waiting: "כולם" }] }]) {
      expect((await request(app).put("/api/tag-plan/sheet").send(bad)).status).toBe(400);
    }
    expect((await sheet()).body.data.sheet.lists).toHaveLength(2);

    expect((await request(app).delete("/api/tag-plan/sheet")).status).toBe(200);
    expect((await sheet()).body.data.sheet).toBeNull();
  });

  it("keeps the old system's students list for the cross-check, and never answers with an ID number", async () => {
    const { Person } = require("../../../models/Person");
    const list = () => request(app).get("/api/tag-plan/old-list");
    expect((await list()).body.data.list).toBeNull();

    // one of our people carries an ID number; another does not
    const dana = await Person.create({ firstName: "דנה", lastName: "בדיקה", idNumber: "012345674" });
    await Person.create({ firstName: "יואב", lastName: "בדיקה" });
    const body = {
      source: "המערכת הישנה",
      takenAt: "2026-11-25T08:00:00.000Z",
      rows: [
        { rid: 7, name: "  דנה   בדיקה ", idNumber: "12345674", phone: "050-000-0001", type: "מתמודד/ת", status: "משובץ-מכללה לכל", residence: "הוסטל", frame: "בית" },
        { rid: 8, name: "רון בדיקה", idNumber: "", phone: "", status: "הוסטלים" },
        { rid: 9, name: "נועה בדיקה", idNumber: "000000018" },
      ],
    };
    const put = await request(app).put("/api/tag-plan/old-list").send(body);
    expect(put.status).toBe(200);
    const got = (await list()).body.data.list;
    expect(got).toMatchObject({ source: "המערכת הישנה", takenAt: "2026-11-25T08:00:00.000Z", ourIds: 1 });
    // an eight-digit number is the same number with its leading zero: the row finds its person
    expect(got.rows).toEqual([
      { rid: "7", name: "דנה בדיקה", phone: "050-000-0001", type: "מתמודד/ת", status: "משובץ-מכללה לכל", residence: "הוסטל", frame: "בית", hasId: true, idPerson: String(dana._id) },
      { rid: "8", name: "רון בדיקה", phone: "", type: "", status: "הוסטלים", residence: "", frame: "", hasId: false, idPerson: null },
      { rid: "9", name: "נועה בדיקה", phone: "", type: "", status: "", residence: "", frame: "", hasId: true, idPerson: null },
    ]);
    // no ID number in what is answered - not on loading, not on reading
    for (const text of [JSON.stringify(put.body), JSON.stringify((await list()).body)]) {
      expect(text).not.toContain("12345674");
      expect(text).not.toContain("000000018");
    }
    // nothing of ours was made or changed by it
    expect(await Person.countDocuments()).toBe(2);

    // nobody else reads or writes it
    TEST_ACCOUNT.kind = "social";
    expect((await list()).status).toBe(403);
    expect((await request(app).put("/api/tag-plan/old-list").send(body)).status).toBe(403);
    expect((await request(app).delete("/api/tag-plan/old-list")).status).toBe(403);
    TEST_ACCOUNT.kind = "super";

    // neither a name nor a number of it rides into the audit
    await new Promise((r) => setTimeout(r, 300));
    const events = JSON.stringify(await AuditEvent.find({}).lean());
    expect(events).not.toContain("נועה");
    expect(events).not.toContain("12345674");

    // what is not a list is refused, and what was loaded stays
    for (const bad of [{}, { rows: [] }, { rows: [{ name: "" }] }, { rows: "כולם" }, { rows: [{ phone: "050" }] }]) {
      expect((await request(app).put("/api/tag-plan/old-list").send(bad)).status).toBe(400);
    }
    expect((await list()).body.data.list.rows).toHaveLength(3);

    // the potential list is another row, kept the same way: each of its rows names the students row with the same ID number
    const pot = await request(app).put("/api/tag-plan/old-list/potential").send({
      rows: [
        { rid: 70, name: "דנה ב", idNumber: "012345674", status: "מתעניין-מכללה לכל", registered: "01/02/2026", lastActivity: "שיחת אינטייק" },
        { rid: 71, name: "אורי בדיקה", idNumber: "000000026" },
      ],
    });
    expect(pot.status).toBe(200);
    expect(pot.body.data.list.rows).toEqual([
      { rid: "70", name: "דנה ב", phone: "", type: "", status: "מתעניין-מכללה לכל", residence: "", frame: "", registered: "01/02/2026", lastActivity: "שיחת אינטייק", hasId: true, idPerson: String(dana._id), idStudent: "7" },
      { rid: "71", name: "אורי בדיקה", phone: "", type: "", status: "", residence: "", frame: "", hasId: true, idPerson: null, idStudent: null },
    ]);
    expect(JSON.stringify(pot.body)).not.toContain("12345674");
    expect((await list()).body.data.list.rows).toHaveLength(3);
    expect((await request(app).get("/api/tag-plan/old-list/nothing")).status).toBe(404);

    // the courses (no person in them) and who is registered to each (a name and an ID number - the number stays inside)
    const courses = await request(app).put("/api/tag-plan/old-list/courses").send({ rows: [{ rid: 900, name: " גיטרה -  קבוצתי ", category: "מכללה לכל (קבוצתי)", manager: "רכזת", capacity: "8", start: "01/09/2026", finish: "30/06/2027", branch: "ירושלים" }, { rid: 901, name: "טיול", capacity: "" }] });
    expect(courses.body.data.list.rows).toEqual([
      { rid: "900", name: "גיטרה - קבוצתי", category: "מכללה לכל (קבוצתי)", manager: "רכזת", capacity: 8, start: "01/09/2026", finish: "30/06/2027", branch: "ירושלים" },
      { rid: "901", name: "טיול", category: "", manager: "", capacity: null, start: "", finish: "", branch: "" },
    ]);
    const seats = await request(app).put("/api/tag-plan/old-list/seats").send({
      rows: [
        { rid: 5000, course: 900, name: "דנה בדיקה", idNumber: "12345674", type: "מתמודד/ת", registered: "01/09/2026", from: "01/09/2026", until: "30/06/2027", weekday: "ג`", time: "10:00", timeEnd: "10:45" },
        { rid: 5001, course: 901, name: "אורי בדיקה", idNumber: "000000026" },
        { rid: 5002, course: 901, name: "בלי מספר" },
      ],
    });
    expect(seats.status).toBe(200);
    expect(seats.body.data.list.rows).toEqual([
      { rid: "5000", course: "900", name: "דנה בדיקה", type: "מתמודד/ת", registered: "01/09/2026", from: "01/09/2026", until: "30/06/2027", weekday: "ג`", time: "10:00", timeEnd: "10:45", hasId: true, idPerson: String(dana._id), idStudent: "7", idPotential: "70" },
      { rid: "5001", course: "901", name: "אורי בדיקה", type: "", registered: "", from: "", until: "", weekday: "", time: "", hasId: true, idPerson: null, idStudent: null, idPotential: "71" },
      { rid: "5002", course: "901", name: "בלי מספר", type: "", registered: "", from: "", until: "", weekday: "", time: "", hasId: false, idPerson: null, idStudent: null, idPotential: null },
    ]);
    expect(JSON.stringify(seats.body)).not.toContain("12345674");
    expect(JSON.stringify(seats.body)).not.toContain("000000026");
    for (const bad of [{ rows: [{ name: "בלי קורס" }] }, { rows: [{ course: 900 }] }]) expect((await request(app).put("/api/tag-plan/old-list/seats").send(bad)).status).toBe(400);
    expect((await request(app).put("/api/tag-plan/old-list/courses").send({ rows: [{ name: "בלי מזהה" }] })).status).toBe(400);
    // the attendance report of a period: a line per person per course, days of the month
    const presence = await request(app).put("/api/tag-plan/old-list/presence").send({ source: "דוח נוכחות", period: "01/11/2026 עד 25/11/2026", rows: [{ course: 900, name: " דנה  בדיקה ", days: ["1", "08", "15", "x"], came: "01, 8", missed: ["15"] }, { course: 901, name: "אורי בדיקה", days: "03" }] });
    expect(presence.status).toBe(200);
    expect(presence.body.data.list).toMatchObject({ period: "01/11/2026 עד 25/11/2026", rows: [{ course: "900", name: "דנה בדיקה", days: "01,08,15", came: "01,08", missed: "15" }, { course: "901", name: "אורי בדיקה", days: "03", came: "", missed: "" }] });
    expect((await request(app).put("/api/tag-plan/old-list/presence").send({ rows: [{ name: "בלי קורס" }] })).status).toBe(400);
    for (const k of ["courses", "seats", "presence"]) expect((await request(app).delete(`/api/tag-plan/old-list/${k}`)).status).toBe(200);
    TEST_ACCOUNT.kind = "manager";
    expect((await request(app).get("/api/tag-plan/old-list/potential")).status).toBe(403);
    TEST_ACCOUNT.kind = "super";
    expect((await request(app).delete("/api/tag-plan/old-list/potential")).status).toBe(200);
    expect((await request(app).get("/api/tag-plan/old-list/potential")).body.data.list).toBeNull();
    expect((await list()).body.data.list.rows).toHaveLength(3);

    expect((await request(app).delete("/api/tag-plan/old-list")).status).toBe(200);
    expect((await list()).body.data.list).toBeNull();
  });

  it("takes only what the page sends", async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ answers: "yes" })).status).toBe(400);
    expect((await put({ answers: { member: { $gt: "" } } })).status).toBe(400);
    expect((await put({ answers: { "bad key!": "a" } })).status).toBe(400);
    expect((await put({ notes: { q: 7 } })).status).toBe(400);
    const long = await put({ notes: { q: "א".repeat(2000) } });
    expect(long.status).toBe(200);
    expect(long.body.data.plan.notes.q.length).toBe(800);
  });
});
