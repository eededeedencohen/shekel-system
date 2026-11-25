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
