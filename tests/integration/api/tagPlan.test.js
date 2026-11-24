/**
 * The students' tags plan (Eden, 2026-11-24: "עמוד שרק לי תהיה אפשרות
 * לראות שבו אנחנו מנהלים את הדברים האלה"): the super admin's answers to the
 * plan's open questions and his notes are kept in one row, his alone to
 * read and to write.
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");

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
