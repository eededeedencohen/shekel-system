/**
 * The tasks the super admin gives the staff (Eden, 2026-11-25): "עמוד שבו
 * אני כרגע יכול לתת משימות לעובדים האחרים… יהיה אפשרות לנהל צ'אט שם פרטי
 * ביני לבין העובד… (כמובן שרק היא יכולה לצפות בנוסף אליי)… המשימה תבוצע
 * כאשר שמרית תיתן סימון לכולם". The bypass actor is borrowed
 * (TEST_ACCOUNT): its `_id` is set to a staff account's, so it IS that
 * account.
 */

const request = require("supertest");
const app = require("../../../app");
const StaffAccount = require("../../../models/StaffAccount");
const StaffTask = require("../../../models/StaffTask");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { makeTeacher } = require("../../helpers/factories");

afterEach(() => Object.assign(TEST_ACCOUNT, { _id: null, username: "test", name: "בדיקות", kind: "super" }));

const api = "/api/staff-tasks";
async function staff() {
  const make = (username, name, kind) => StaffAccount.create({ username, name, kind, passwordHash: "x" });
  const [eden, shimrit, noa, teacher] = await Promise.all([make("eden", "עדן", "super"), make("shimrit", "שמרית", "hostels"), make("noa", "נעה", "manager"), make("mora", "מורה", "teacher")]);
  return { eden, shimrit, noa, teacher };
}
const actAs = (a) => Object.assign(TEST_ACCOUNT, { _id: a._id, username: a.username, name: a.name, kind: a.kind });
const mine = async () => (await request(app).get(api)).body.data.tasks;

describe("the tasks the super admin gives the staff", () => {
  it("are given by the super admin alone, to a person of the staff, and seen by the two of them only", async () => {
    const s = await staff();
    actAs(s.eden);
    const made = await request(app).post(api).send({ title: "  לסמן   את השבוע ", body: "שורה אחת\n\nשורה שתיים", assignee: String(s.shimrit._id), linkTo: "/hostel-week?tab=week", linkLabel: "לעמוד השבוע" });
    expect(made.status).toBe(201);
    const t = made.body.data.task;
    expect(t).toMatchObject({ title: "לסמן את השבוע", body: "שורה אחת\n\nשורה שתיים", assignee: String(s.shimrit._id), assigneeName: "שמרית", by: String(s.eden._id), byName: "עדן", linkTo: "/hostel-week?tab=week", linkLabel: "לעמוד השבוע", done: false, auto: null, unread: 0 });
    // not a task: no title, nobody to give it to, a teacher's account, an address outside the app, a rule nobody knows
    for (const bad of [{ assignee: String(s.shimrit._id) }, { title: "x" }, { title: "x", assignee: String(s.teacher._id) }, { title: "x", assignee: "nobody" }, { title: "x", assignee: String(s.shimrit._id), linkTo: "https://evil.example" }, { title: "x", assignee: String(s.shimrit._id), linkTo: "//evil.example" }, { title: "x", assignee: String(s.shimrit._id), auto: "whenever" }]) {
      const r = await request(app).post(api).send(bad);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("TASK_INVALID");
    }
    expect((await mine()).map((x) => x.title)).toEqual(["לסמן את השבוע"]);

    actAs(s.shimrit);
    expect((await mine()).map((x) => x.title)).toEqual(["לסמן את השבוע"]);
    expect((await request(app).post(api).send({ title: "משלי", assignee: String(s.noa._id) })).status).toBe(403);
    expect((await request(app).patch(`${api}/${t._id}`).send({ title: "אחרת" })).status).toBe(403);
    expect((await request(app).delete(`${api}/${t._id}`)).status).toBe(403);

    // for anyone else it does not exist
    actAs(s.noa);
    expect(await mine()).toEqual([]);
    for (const r of [await request(app).put(`${api}/${t._id}/done`).send({ done: true }), await request(app).post(`${api}/${t._id}/messages`).send({ text: "שלום" }), await request(app).put(`${api}/${t._id}/seen`)]) expect(r.status).toBe(404);

    actAs(s.eden);
    expect((await request(app).patch(`${api}/${t._id}`).send({ title: "לסמן את כל השבוע", linkTo: "" })).body.data.task).toMatchObject({ title: "לסמן את כל השבוע", linkTo: "", linkLabel: "" });
    expect((await request(app).delete(`${api}/${t._id}`)).status).toBe(204);
    expect(await StaffTask.countDocuments()).toBe(0);
  });

  it("the two talk on a task, each told what is new since the last look; either says it is done", async () => {
    const s = await staff();
    actAs(s.eden);
    const t = (await request(app).post(api).send({ title: "לבדוק חשבוניות", assignee: String(s.shimrit._id) })).body.data.task;

    actAs(s.shimrit);
    const said = await request(app).post(`${api}/${t._id}/messages`).send({ text: "  עד מתי?  " });
    expect(said.status).toBe(201);
    expect(said.body.data.task.messages.map((m) => [m.fromName, m.text])).toEqual([["שמרית", "עד מתי?"]]);
    expect(said.body.data.task.unread).toBe(0);
    expect((await request(app).post(`${api}/${t._id}/messages`).send({ text: "   " })).status).toBe(400);

    actAs(s.eden);
    expect((await mine())[0].unread).toBe(1);
    expect((await request(app).put(`${api}/${t._id}/seen`)).body.data.task.unread).toBe(0);
    await request(app).post(`${api}/${t._id}/messages`).send({ text: "עד יום חמישי" });
    await request(app).post(`${api}/${t._id}/messages`).send({ text: "ותודה" });

    actAs(s.shimrit);
    const hers = (await mine())[0];
    expect(hers.unread).toBe(2);
    expect(hers.messages.map((m) => m.text)).toEqual(["עד מתי?", "עד יום חמישי", "ותודה"]);
    // she says it is done; he opens it again
    const done = (await request(app).put(`${api}/${t._id}/done`).send({ done: true })).body.data.task;
    expect(done).toMatchObject({ done: true, doneBy: "שמרית" });
    expect(done.doneAt).toBeTruthy();
    actAs(s.eden);
    expect((await request(app).put(`${api}/${t._id}/done`).send({ done: false })).body.data.task).toMatchObject({ done: false, doneBy: "", doneAt: null });
  });

  it("is new to the one who got it until their own first look - a look through their eyes is not theirs", async () => {
    const tasks = require("../../../services/staffTaskService");
    const s = await staff();
    actAs(s.eden);
    const t = (await request(app).post(api).send({ title: "לבדוק חשבוניות", assignee: String(s.shimrit._id) })).body.data.task;
    // the one who gave it has looked at it; the one who got it has not
    expect(t.seenAt).toBeTruthy();
    actAs(s.shimrit);
    expect((await mine())[0].seenAt).toBeNull();

    // the super admin viewing as her opens the task: the answer reads as looked at, and nothing is written
    const hers = { _id: s.shimrit._id, username: "shimrit", name: "שמרית", kind: "hostels" };
    expect((await tasks.look({ id: t._id, actor: hers, viewing: true })).seenAt).toBeTruthy();
    expect((await mine())[0].seenAt).toBeNull();

    // her own look: the task is not new any more, and it still waits
    expect((await request(app).put(`${api}/${t._id}/seen`)).body.data.task.seenAt).toBeTruthy();
    expect((await mine())[0]).toMatchObject({ done: false });
    expect((await mine())[0].seenAt).toBeTruthy();
  });

  it("a task with a rule is done by the data, never by a tick: every lesson of the week census marked", async () => {
    const s = await staff();
    const tomer = await makeTeacher({ firstName: "תומר", lastName: "דורון" });
    actAs(s.eden);
    const plan = (await request(app).post("/api/week-plans").send({ teachers: [String(tomer._id)] })).body.data.plans[0];
    const lesson = (day) => ({ day, start: "10:00", end: "11:00", subject: "קרמיקה", hostelName: "הוסטל השקד", place: "hostel" });
    await request(app).post(`/api/week-plans/${plan._id}/entries`).send(lesson(0));
    const two = (await request(app).post(`/api/week-plans/${plan._id}/entries`).send(lesson(1))).body.data.plan.entries;
    const t = (await request(app).post(api).send({ title: "לסמן תקין ולא תקין", assignee: String(s.shimrit._id), auto: "weekCensusChecked" })).body.data.task;
    expect(t.auto).toMatchObject({ rule: "weekCensusChecked", done: 0, total: 2 });
    expect(t.done).toBe(false);

    actAs(s.shimrit);
    const refused = await request(app).put(`${api}/${t._id}/done`).send({ done: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("TASK_AUTO");
    const check = (id, body) => request(app).put(`/api/week-plans/${plan._id}/entries/${id}/check`).send(body);
    await check(two[0]._id, { state: "ok" });
    expect((await mine())[0]).toMatchObject({ done: false, auto: { done: 1, total: 2 } });
    await check(two[1]._id, { state: "bad", reason: "college" });
    const done = (await mine())[0];
    expect(done).toMatchObject({ done: true, auto: { done: 2, total: 2 } });
    expect(done.doneAt).toBeTruthy();
    // a lesson added later is a lesson not marked: the task is open again
    await request(app).post(`/api/week-plans/${plan._id}/entries`).send(lesson(2));
    expect((await mine())[0]).toMatchObject({ done: false, doneAt: null, auto: { done: 2, total: 3 } });
  });
});
