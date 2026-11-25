/**
 * The prepared actions (/api/prepared-actions): a change to the data written down in full, run when the super admin
 * approves - through the app's own services, never overwriting what is already there.
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { Person } = require("../../../models/Person");
const { Profile } = require("../../../models/profiles");
const Subject = require("../../../models/Subject");
const Cycle = require("../../../models/Cycle");
const Enrollment = require("../../../models/Enrollment");
const PreparedAction = require("../../../models/PreparedAction");
const tags = require("../../../services/tagService");
const { makeStudent, makeTeacher, makeRoom } = require("../../helpers/factories");
const { createPersonWithProfile } = require("../../../services/profileService");

afterEach(() => {
  TEST_ACCOUNT.kind = "super";
});

const post = (path, body) => request(app).post(`/api/prepared-actions${path}`).send(body);
const list = async () => (await request(app).get("/api/prepared-actions")).body.data.actions;
const step = (action, id) => action.steps.find((s) => s.id === id);

/** A teacher, a course of the catalogue, two running courses, three students (one of ours, one new, one of ours with no college) and their seats. */
const action = (known, cultureOnly, extra = {}) => ({
  title: "ערבית עם מורה חדש",
  summary: "מורה, קורס בקטלוג, שני קורסים, שלושה סטודנטים",
  source: "בדיקה",
  notes: ["שורה אחת לא נכללה"],
  steps: [
    { id: "s1", kind: "teacher", label: "המורה דני ערבי", data: { firstName: "דני", lastName: "ערבי", phone: "052-1112223" } },
    { id: "s2", kind: "subject", label: "הקורס ערבית", data: { name: "ערבית", category: "enrichment" } },
    { id: "s3", kind: "cycle", label: "ערבית, יום ראשון 13:00", data: { subject: "$s2", teacher: "$s1", schedule: [{ day: 0, start: "13:00", end: "13:50", room: "סטודיו גרפיקה" }], startDate: "25/10/2026", endDate: "31/12/2027", senzeyCourseId: "SENZEY_1701", senzeyName: "ערבית - דני - א` - 13:00 - 13:50" } },
    { id: "s4", kind: "cycle", label: "ערבית, יום ראשון 14:00", data: { subject: "$s2", teacher: "$s1", schedule: [{ day: 0, start: "14:00", end: "15:00", room: "חדר שאין" }], startDate: "2026-10-25", endDate: "2027-12-31", capacity: 1 } },
    { id: "s5", kind: "student", label: "סטודנט שכבר במערכת", data: { person: String(known._id) } },
    { id: "s6", kind: "student", label: "סטודנטית חדשה", optional: true, data: { firstName: "רותי", lastName: "חדשה" } },
    { id: "s7", kind: "student", label: "במערכת, בלי מכללה לכל", data: { person: String(cultureOnly._id) } },
    { id: "s8", kind: "seat", label: "הראשון בקורס של 13:00", data: { student: "$s5", cycle: "$s3" } },
    { id: "s9", kind: "seat", label: "החדשה בקורס של 13:00", data: { student: "$s6", cycle: "$s3" } },
    { id: "s10", kind: "seat", label: "השלישי בקורס של 14:00", data: { student: "$s7", cycle: "$s4" } },
    { id: "s11", kind: "seat", label: "הראשון גם בקורס של 14:00, שיש בו מקום אחד", data: { student: "$s5", cycle: "$s4" } },
  ],
  ...extra,
});

const people = async () => {
  const known = await makeStudent({ firstName: "יוסי", lastName: "קיים", phone: "050-1234567" });
  const { person: cultureOnly } = await createPersonWithProfile("StudentCulture", { firstName: "מיכל", lastName: "תרבות" }, { pipelineInit: { stage: "Placed", movedBy: "בדיקה" } });
  await makeRoom({ name: "סטודיו גרפיקה" });
  return { known, cultureOnly };
};

describe("the prepared actions", () => {
  it("is the super admin's alone", async () => {
    TEST_ACCOUNT.kind = "manager";
    expect((await request(app).get("/api/prepared-actions")).status).toBe(403);
    expect((await post("", { title: "x", steps: [] })).status).toBe(403);
  });

  it("refuses an action that is not whole", async () => {
    const { known, cultureOnly } = await people();
    const bad = (change) => post("", change(action(known, cultureOnly)));
    expect((await post("", { title: "בלי צעדים", steps: [] })).body.code).toBe("ACTION_INVALID");
    expect((await bad((a) => ({ ...a, title: " " }))).status).toBe(400);
    // a pointer to a step that is not before it, to a step of the wrong kind, a day that is not a day, an end before its start
    expect((await bad((a) => ({ ...a, steps: [a.steps[2]] }))).status).toBe(400);
    expect((await bad((a) => ({ ...a, steps: [a.steps[0], { id: "s2", kind: "seat", label: "x", data: { student: "$s1", cycle: "$s1" } }] }))).status).toBe(400);
    expect((await bad((a) => ({ ...a, steps: [a.steps[0], a.steps[1], { ...a.steps[2], data: { ...a.steps[2].data, startDate: "31/02/2026" } }] }))).status).toBe(400);
    expect((await bad((a) => ({ ...a, steps: [a.steps[0], a.steps[1], { ...a.steps[2], data: { ...a.steps[2].data, schedule: [{ day: 0, start: "14:00", end: "13:00" }] } }] }))).status).toBe(400);
    expect((await bad((a) => ({ ...a, steps: [a.steps[0], { ...a.steps[0] }] }))).status).toBe(400);
    expect(await PreparedAction.countDocuments()).toBe(0);
  });

  it("says before the approval what every step would do, and changes nothing by saying it", async () => {
    const { known, cultureOnly } = await people();
    const made = await post("", action(known, cultureOnly));
    expect(made.status).toBe(201);
    const a = made.body.data.action;
    expect(a.status).toBe("ready");
    expect(a.steps[0].data).toBeUndefined();
    expect(a.steps.map((s) => s.will.state)).toEqual(["make", "make", "make", "make", "found", "make", "open", "make", "make", "make", "make"]);
    expect(step(a, "s5").will.text).toMatch(/יוסי קיים/);
    expect(step(a, "s7").will.text).toMatch(/בלי מכללה לכל/);
    expect(step(a, "s9").needs).toEqual(["s6", "s3"]);
    expect((await request(app).get("/api/prepared-actions/count")).body.data.waiting).toBe(1);
    // nothing was made by looking
    expect(await Subject.countDocuments()).toBe(0);
    expect(await Cycle.countDocuments()).toBe(0);
    expect(await Profile.countDocuments({ kind: "Teacher" })).toBe(0);
    expect(await tags.holds(cultureOnly._id, "college")).toBe(false);
  });

  it("runs on approval, through the app's own ways, and keeps what each step did", async () => {
    const { known, cultureOnly } = await people();
    const before = await Person.findById(known._id).lean();
    const id = (await post("", action(known, cultureOnly))).body.data.action._id;
    const done = await post(`/${id}/approve`, {});
    expect(done.status).toBe(200);
    const a = done.body.data.action;
    expect(a.steps.map((s) => s.outcome.status)).toEqual(["made", "made", "made", "made", "found", "made", "made", "made", "made", "made", "failed"]);
    // the one failure (a course of one place, taken) does not stop the rest, and the action says it is not whole
    expect(a.status).toBe("partial");
    expect(step(a, "s11").outcome.message).toMatch(/אין מקום פנוי/);
    expect(a.approvedBy).toBeTruthy();

    const teacher = await Person.findOne({ firstName: "דני", lastName: "ערבי" });
    expect(teacher.phone).toBe("052-1112223");
    expect(await Profile.countDocuments({ person: teacher._id, kind: "Teacher", active: true })).toBe(1);
    expect(await tags.holds(teacher._id, "teacher")).toBe(true);
    const subject = await Subject.findOne({ name: "ערבית" });
    expect(subject.category).toBe("enrichment");
    const first = await Cycle.findOne({ "import.senzeyCourseId": "SENZEY_1701" }).populate("schedule.room");
    expect(String(first.teacher)).toBe(String(teacher._id));
    expect(String(first.subject)).toBe(String(subject._id));
    expect(first.schedule[0].day).toBe(0);
    expect(first.schedule[0].start).toBe("13:00");
    expect(first.schedule[0].room.name).toBe("סטודיו גרפיקה");
    expect(first.startDate.toISOString().slice(0, 10)).toBe("2026-10-25");
    expect(first.endDate.toISOString().slice(0, 10)).toBe("2027-12-31");
    expect(first.status).toBe("Active");
    // a room the app does not hold: the course is made without it, and says so
    const second = await Cycle.findOne({ subject: subject._id, "schedule.start": "14:00" });
    expect(second.schedule[0].room).toBeNull();
    expect(step(a, "s4").outcome.message).toMatch(/חדר שאין/);
    expect(step(a, "s3").outcome.ref).toBe(String(first._id));

    // the student of ours: found, untouched, seated
    expect(await Person.findById(known._id).lean()).toEqual(before);
    expect(await Enrollment.countDocuments({ cycle: first._id, student: known._id, status: "active" })).toBe(1);
    // the new one: a person, in the college, and placed by the seat
    const ruti = await Person.findOne({ firstName: "רותי", lastName: "חדשה" });
    expect(await tags.holds(ruti._id, "college")).toBe(true);
    expect((await Profile.findOne({ person: ruti._id, kind: "StudentCollege" })).pipeline.stage).toBe("Placed");
    expect(await Enrollment.countDocuments({ cycle: first._id, student: ruti._id, status: "active" })).toBe(1);
    // the one who was of culture alone: the college is opened beside it, culture stays
    expect(await tags.holds(cultureOnly._id, "college")).toBe(true);
    expect(await Profile.countDocuments({ person: cultureOnly._id, kind: "StudentCulture", active: true })).toBe(1);
    expect(step(a, "s7").outcome.message).toMatch(/נפתחה/);
    expect(await Enrollment.countDocuments({ cycle: second._id, student: cultureOnly._id, status: "active" })).toBe(1);

    // approving again runs only what did not run: nothing is made twice
    const again = await post(`/${id}/approve`, {});
    expect(again.body.data.action.steps.map((s) => s.outcome.status)).toEqual(["made", "made", "made", "made", "found", "made", "made", "made", "made", "made", "failed"]);
    expect(await Cycle.countDocuments()).toBe(2);
    expect(await Enrollment.countDocuments()).toBe(3);
    expect(await Person.countDocuments({ firstName: "רותי" })).toBe(1);
  });

  it("leaves out what he took the tick off, and whatever leaned on it", async () => {
    const { known, cultureOnly } = await people();
    const a0 = action(known, cultureOnly);
    a0.steps.pop(); // without the seat that cannot be
    const id = (await post("", a0)).body.data.action._id;
    const a = (await post(`/${id}/approve`, { skip: ["s6", "s1"] })).body.data.action;
    // s1 is not optional: it runs whatever was sent
    expect(step(a, "s1").outcome.status).toBe("made");
    expect(step(a, "s6").outcome).toMatchObject({ status: "skipped", message: "הוצא מהפעולה לפני האישור" });
    expect(step(a, "s9").outcome).toMatchObject({ status: "skipped", message: "תלוי בצעד שהוצא מהפעולה" });
    expect(await Person.countDocuments({ firstName: "רותי" })).toBe(0);
    // what he left out by his own word is not a failure: the action is done without it
    expect(a.status).toBe("done");
  });

  it("a second action of the same things finds everything, and makes nothing", async () => {
    const { known, cultureOnly } = await people();
    const a0 = action(known, cultureOnly);
    a0.steps.pop();
    const first = (await post("", a0)).body.data.action._id;
    expect((await post(`/${first}/approve`, {})).body.data.action.status).toBe("done");
    const counts = async () => [await Person.countDocuments(), await Subject.countDocuments(), await Cycle.countDocuments(), await Enrollment.countDocuments(), await Profile.countDocuments()];
    const was = await counts();
    const second = (await post("", a0)).body.data.action;
    expect(second.steps.map((s) => s.will.state)).toEqual(["found", "found", "found", "found", "found", "found", "found", "found", "found", "found"]);
    const done = (await post(`/${second._id}/approve`, {})).body.data.action;
    expect(done.status).toBe("done");
    expect(done.steps.every((s) => s.outcome.status === "found")).toBe(true);
    expect(await counts()).toEqual(was);
  });

  it("an action runs once, and one put aside does not run", async () => {
    const { known, cultureOnly } = await people();
    const a0 = action(known, cultureOnly);
    a0.steps.pop();
    const id = (await post("", a0)).body.data.action._id;
    expect((await post(`/${id}/approve`, {})).body.data.action.status).toBe("done");
    expect((await post(`/${id}/approve`, {})).body.code).toBe("ACTION_NOT_READY");
    expect((await post(`/${id}/cancel`)).body.code).toBe("ACTION_NOT_READY");
    // a waiting action may be written again; one that ran may not
    expect((await request(app).put(`/api/prepared-actions/${id}`).send(a0)).body.code).toBe("ACTION_NOT_READY");
    const other = (await post("", { ...a0, title: "אחרת" })).body.data.action._id;
    const again = await request(app).put(`/api/prepared-actions/${other}`).send({ ...a0, title: "אחרת, מתוקנת", steps: a0.steps.slice(0, 2) });
    expect(again.body.data.action).toMatchObject({ title: "אחרת, מתוקנת", status: "ready" });
    expect(again.body.data.action.steps).toHaveLength(2);
    expect((await request(app).put(`/api/prepared-actions/${other}`).send({ title: "", steps: [] })).status).toBe(400);
    expect((await post(`/${other}/cancel`)).body.data.action.status).toBe("cancelled");
    expect((await post(`/${other}/approve`, {})).status).toBe(409);
    expect((await post("/000000000000000000000000/approve", {})).status).toBe(409);
    const all = await list();
    expect(all.map((x) => x.status)).toEqual(["done", "cancelled"]);
    expect((await request(app).get("/api/prepared-actions/count")).body.data.waiting).toBe(0);
  });

  it("an existing teacher of the same name is found, not made again; two of one name stop the step", async () => {
    const { known, cultureOnly } = await people();
    const t = await makeTeacher({ firstName: "דני", lastName: "ערבי" });
    const a0 = action(known, cultureOnly);
    a0.steps.pop();
    const made = (await post("", a0)).body.data.action;
    expect(step(made, "s1").will.state).toBe("found");
    const done = (await post(`/${made._id}/approve`, {})).body.data.action;
    expect(step(done, "s1").outcome).toMatchObject({ status: "found", ref: String(t._id) });
    expect(await Person.countDocuments({ firstName: "דני", lastName: "ערבי" })).toBe(1);
    // the phone the action carried is not written over the teacher who was there
    expect((await Person.findById(t._id)).phone).toBeUndefined();
    await makeTeacher({ firstName: "דני", lastName: "ערבי" });
    const twice = (await post("", { ...a0, title: "שוב" })).body.data.action;
    expect(step(twice, "s1").will.state).toBe("blocked");
  });
});
