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
