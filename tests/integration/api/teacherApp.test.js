/**
 * @file The teachers' app (Eden, 2026-11-16): a teacher's own account
 *
 * Runs with AUTH_ENFORCE=1 - the gate is real here. What must hold:
 *   - a teacher's account is tied to ONE teacher, opens with a password
 *     nobody knows (the reset link is the first way in), and never becomes
 *     a staff account
 *   - signed in, it reaches /api/teacher and its own /api/auth - every
 *     other router answers 403, the ones open to every staff kind included
 *   - the board holds his own college courses only, and of a student a name
 *     and a face only
 *   - attendance: his own course, a day it meets, not the future, only who
 *     sits in it; the other marks of that day stay
 *   - the super admin viewing as a teacher is held to the same lines
 */

const request = require("supertest");
const app = require("../../../app");
const StaffAccount = require("../../../models/StaffAccount");
const Lesson = require("../../../models/Lesson");
const { Person } = require("../../../models/Person");
const { ensureSeedAccounts } = require("../../../services/authService");
const { defaultPasswordFor } = require("../../../utils/password");
const { lensOf } = require("../../../services/lensService");
const { todayStr, addDays } = require("../../../services/teacherAppService");
const { makeTeacher, makeStudent, makeCycle, makeEnrollment, makeHostel } = require("../../helpers/factories");
const rounds = require("../../../services/invoiceRoundService");
const InvoiceRound = require("../../../models/InvoiceRound");
const InvoiceRequest = require("../../../models/InvoiceRequest");
const storage = require("../../../services/storage");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

beforeAll(() => {
  process.env.AUTH_ENFORCE = "1";
});
afterAll(() => {
  delete process.env.AUTH_ENFORCE;
});

const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const signIn = async (username, password = defaultPasswordFor(username)) => {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  return { res, cookie: cookieOf(res) };
};
const TOKEN = "t".repeat(40);
const PASSWORD = "piano-1234";

/** The latest day, today or before, that a course may meet on (Sunday to Thursday). */
const lessonDay = () => {
  let d = todayStr();
  while (new Date(`${d}T00:00:00.000Z`).getUTCDay() > 4) d = addDays(d, -1);
  return d;
};

/** A world: teacher T with a college course X (two students) and a house course Z; teacher U with course Y. */
async function world() {
  await ensureSeedAccounts();
  const date = lessonDay();
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const span = { startDate: new Date(`${addDays(date, -60)}T00:00:00.000Z`), endDate: new Date(`${addDays(date, 60)}T00:00:00.000Z`), schedule: [{ day, start: "10:00", end: "10:45" }] };
  const joinedAt = new Date(`${addDays(date, -30)}T00:00:00.000Z`);
  const T = await makeTeacher({ firstName: "אלה", lastName: "בדיקה", phone: "050-1111111" });
  const U = await makeTeacher({ firstName: "דן", lastName: "אחר" });
  const [s1, s2, s3] = await Promise.all([
    makeStudent({ firstName: "רותי", lastName: "א", phone: "052-9999999" }),
    makeStudent({ firstName: "יוסי", lastName: "ב" }),
    makeStudent({ firstName: "דנה", lastName: "ג" }),
  ]);
  const hostel = await makeHostel();
  const X = await makeCycle({ teacher: T._id, ...span });
  const Y = await makeCycle({ teacher: U._id, ...span });
  const Z = await makeCycle({ teacher: T._id, hostel: hostel._id, ...span });
  await makeEnrollment({ cycle: X._id, student: s1._id, joinedAt });
  await makeEnrollment({ cycle: X._id, student: s2._id, joinedAt });
  await makeEnrollment({ cycle: Y._id, student: s3._id, joinedAt });
  await makeEnrollment({ cycle: Z._id, student: s3._id, joinedAt });
  const eden = (await signIn("eden")).cookie;
  return { date, day, T, U, s1, s2, s3, X, Y, Z, eden };
}

/** eden opens T's account, sends the link, the teacher picks a password: the teacher's cookie. */
async function teacherIn(w, username = "ella") {
  const made = await request(app).post("/api/accounts").set("Cookie", w.eden).send({ username, name: "אלה בדיקה", kind: "teacher", person: String(w.T._id) });
  expect(made.status).toBe(201);
  const id = made.body.data.account._id;
  const link = await request(app).post(`/api/accounts/${id}/reset`).set("Cookie", w.eden).send({ token: TOKEN });
  expect(link.status).toBe(201);
  const reset = await request(app).post(`/api/auth/reset/${TOKEN}`).send({ password: PASSWORD });
  expect(reset.status).toBe(200);
  return { id, cookie: cookieOf(reset), account: reset.body.data.account };
}

describe("the teachers' app", () => {
  test("a teacher's account: one teacher, one account, no guessable first password, never staff", async () => {
    const w = await world();
    const post = (body) => request(app).post("/api/accounts").set("Cookie", w.eden).send(body);
    // tied to a teacher from the list
    expect((await post({ username: "ella", name: "אלה", kind: "teacher" })).body.code).toBe("TEACHER_PERSON_REQUIRED");
    expect((await post({ username: "ella", name: "אלה", kind: "teacher", person: String(w.s1._id) })).body.code).toBe("TEACHER_PERSON_REQUIRED");
    const made = await post({ username: "ella", name: "אלה בדיקה", kind: "teacher", person: String(w.T._id), features: ["gym"] });
    expect(made.status).toBe(201);
    expect(made.body.data.account).toMatchObject({ kind: "teacher", person: String(w.T._id), features: [] });
    // one account per teacher
    expect((await post({ username: "ella2", name: "אלה", kind: "teacher", person: String(w.T._id) })).body.code).toBe("TEACHER_ACCOUNT_EXISTS");
    // the default password of "ella" does not open it
    expect((await signIn("ella")).res.status).toBe(401);
    // a kind never crosses the line, in either direction
    const id = made.body.data.account._id;
    expect((await request(app).patch(`/api/accounts/${id}`).set("Cookie", w.eden).send({ kind: "manager" })).body.code).toBe("TEACHER_KIND_FIXED");
    const hagai = await StaffAccount.findOne({ username: "hagai" });
    expect((await request(app).patch(`/api/accounts/${hagai._id}`).set("Cookie", w.eden).send({ kind: "teacher", person: String(w.U._id) })).body.code).toBe("TEACHER_KIND_FIXED");
    // the super admin may change the user name
    const renamed = await request(app).patch(`/api/accounts/${id}`).set("Cookie", w.eden).send({ username: "ella.b" });
    expect(renamed.body.data.account.username).toBe("ella.b");
  });

  test("the reset link is the way in; signed in, everything but the teacher's own router and account is closed", async () => {
    const w = await world();
    const t = await teacherIn(w);
    expect(t.account).toMatchObject({ username: "ella", kind: "teacher", person: String(w.T._id) });
    const get = (path) => request(app).get(path).set("Cookie", t.cookie);
    expect((await get("/api/auth/me")).body.data.account.kind).toBe("teacher");
    expect((await get("/api/teacher/board")).status).toBe(200);
    // the family routers, and the ones open to every staff kind
    for (const path of ["/api/people", `/api/people/${w.s1._id}`, "/api/profiles", "/api/cycles", "/api/enrollments", `/api/lessons?cycle=${w.X._id}`, "/api/intakes", "/api/activities", "/api/incidents", "/api/diary", "/api/tags", "/api/meta/domain", "/api/files", "/api/accounts", "/api/hostels", "/api/suppliers", "/api/db/schema", "/api/audit/online"]) {
      const res = await get(path);
      expect([path, res.status, res.body.code]).toEqual([path, 403, "TEACHER_APP_ONLY"]);
    }
    expect((await request(app).put("/api/lessons/attendance").set("Cookie", t.cookie).send({ cycle: String(w.X._id), date: w.date, records: [] })).status).toBe(403);
    expect((await request(app).patch(`/api/people/${w.T._id}/availability`).set("Cookie", t.cookie).send({ availability: [] })).status).toBe(403);
    // the staff directory is the staff's
    expect((await get("/api/auth/staff")).status).toBe(403);
    // and a staff member does not reach the teachers' router
    const hagai = (await signIn("hagai")).cookie;
    expect((await request(app).get("/api/teacher/board").set("Cookie", hagai)).status).toBe(403);
    expect((await request(app).get("/api/teacher/board").set("Cookie", w.eden)).status).toBe(403);
    expect((await request(app).get("/api/teacher/board")).status).toBe(401);
  });

  test("the lens of a kind it does not know is nobody's", () => {
    expect(lensOf({ kind: "teacher" })).toMatchObject({ all: false, collegeOnly: false, hostelsOnly: false, cultureOnly: false, gym: false });
    expect(lensOf({ kind: "something-new" }).all).toBe(false);
    expect(lensOf({ kind: "super" }).all).toBe(true);
    expect(lensOf({ kind: "social" }).all).toBe(true);
    expect(lensOf({ kind: "manager" })).toMatchObject({ all: false, collegeOnly: true });
  });

  test("the board: his own college courses, and of a student a name and a face", async () => {
    const w = await world();
    const t = await teacherIn(w);
    const res = await request(app).get("/api/teacher/board").set("Cookie", t.cookie);
    const b = res.body.data;
    expect(b.today).toBe(todayStr());
    expect(b.me).toMatchObject({ _id: String(w.T._id), firstName: "אלה", phone: "050-1111111" });
    // X alone: not another teacher's Y, not the house's Z
    expect(b.cycles.map((c) => c._id)).toEqual([String(w.X._id)]);
    expect(b.cycles[0].schedule[0]).toMatchObject({ day: w.day, start: "10:00", end: "10:45" });
    expect(b.seats.map((s) => s.student.firstName).sort()).toEqual(["יוסי", "רותי"]);
    for (const seat of b.seats) expect(Object.keys(seat.student).sort()).toEqual(["_id", "avatar", "firstName", "gender", "lastName"]);
    // nothing of a student's phone anywhere in the answer
    expect(JSON.stringify(b)).not.toContain("052-9999999");
  });

  test("attendance: his course, a day it meets, not the future, only who sits in it; other marks stay", async () => {
    const w = await world();
    const t = await teacherIn(w);
    const put = (body) => request(app).put("/api/teacher/attendance").set("Cookie", t.cookie).send(body);
    const X = String(w.X._id);
    const ok = await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "Present" }] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.lesson).toMatchObject({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "Present" }] });
    // a second mark joins the first; a note is kept
    const two = await put({ cycle: X, date: w.date, marks: [{ student: String(w.s2._id), status: "Missing", note: "לא ענה לטלפון" }] });
    expect(two.body.data.lesson.marks.map((m) => m.status).sort()).toEqual(["Missing", "Present"]);
    // changed, then taken back
    await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "AnnouncedAbsence" }] });
    const back = await put({ cycle: X, date: w.date, marks: [{ student: String(w.s2._id), status: null }] });
    expect(back.body.data.lesson.marks).toEqual([{ student: String(w.s1._id), status: "AnnouncedAbsence", note: "", reason: null }]);
    // an absence may say why (the hostels' reasons); a word that is not one of them is refused; whoever came carries none
    const why = await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "AnnouncedAbsence", reason: "hospital" }] });
    expect(why.body.data.lesson.marks[0]).toMatchObject({ status: "AnnouncedAbsence", reason: "hospital" });
    expect((await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "AnnouncedAbsence", reason: "flu" }] })).body.code).toBe("ATTENDANCE_REASON_INVALID");
    expect((await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "AnnouncedAbsence", reason: null }] })).body.data.lesson.marks[0].reason).toBeNull();
    // "לא הגיע ולא הודיע" has no why: the reason goes with the mark, and one sent with it is not kept
    await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "AnnouncedAbsence", reason: "vacation" }] });
    expect((await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "Missing" }] })).body.data.lesson.marks[0]).toMatchObject({ status: "Missing", reason: null });
    expect((await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "Missing", reason: "hospital" }] })).body.data.lesson.marks[0].reason).toBeNull();
    await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "AnnouncedAbsence", reason: "vacation" }] });
    expect((await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "Present" }] })).body.data.lesson.marks[0]).toMatchObject({ status: "Present", reason: null });
    await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "AnnouncedAbsence" }] });
    expect(await Lesson.countDocuments({ cycle: w.X._id })).toBe(1);

    // not his course, not the house's course
    expect((await put({ cycle: String(w.Y._id), date: w.date, marks: [{ student: String(w.s3._id), status: "Present" }] })).body.code).toBe("LESSON_NOT_YOURS");
    expect((await put({ cycle: String(w.Z._id), date: w.date, marks: [{ student: String(w.s3._id), status: "Present" }] })).body.code).toBe("LESSON_NOT_YOURS");
    // someone who does not sit in it
    expect((await put({ cycle: X, date: w.date, marks: [{ student: String(w.s3._id), status: "Present" }] })).body.code).toBe("LESSON_STUDENT_INVALID");
    // the future, a day the course does not meet, a day before the window
    expect((await put({ cycle: X, date: addDays(w.date, 7), marks: [{ student: String(w.s1._id), status: "Present" }] })).body.code).toBe("LESSON_DATE_INVALID");
    expect((await put({ cycle: X, date: addDays(w.date, -1), marks: [{ student: String(w.s1._id), status: "Present" }] })).body.code).toBe("LESSON_DATE_INVALID");
    expect((await put({ cycle: X, date: addDays(w.date, -42), marks: [{ student: String(w.s1._id), status: "Present" }] })).body.code).toBe("LESSON_DATE_INVALID");
    // a status that is not one of the three
    expect((await put({ cycle: X, date: w.date, marks: [{ student: String(w.s1._id), status: "Late" }] })).body.code).toBe("ATTENDANCE_INVALID");
    expect(await Lesson.countDocuments()).toBe(1);
  });

  test("his own windows: the programs' windows stay as the staff set them", async () => {
    const w = await world();
    await Person.updateOne({ _id: w.T._id }, { availability: [{ day: 1, start: "09:00", end: "12:00", program: "college" }, { day: 2, start: "09:00", end: "10:00", program: null }] });
    const t = await teacherIn(w);
    const res = await request(app).patch("/api/teacher/availability").set("Cookie", t.cookie).send({ windows: [{ day: 3, start: "14:00", end: "17:00", program: "hostels" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.availability).toEqual([
      { day: 1, start: "09:00", end: "12:00", program: "college" },
      { day: 3, start: "14:00", end: "17:00", program: null },
    ]);
    expect((await request(app).patch("/api/teacher/availability").set("Cookie", t.cookie).send({ windows: [{ day: 3, start: "17:00", end: "14:00" }] })).body.code).toBe("AVAILABILITY_INVALID");
  });

  test("a teacher changes his own user name; the password and the session stay", async () => {
    const w = await world();
    const t = await teacherIn(w);
    const patch = (username) => request(app).patch("/api/auth/username").set("Cookie", t.cookie).send({ username });
    expect((await patch("אלה")).body.code).toBe("USERNAME_INVALID");
    expect((await patch("x")).body.code).toBe("USERNAME_INVALID");
    expect((await patch("hagai")).body.code).toBe("USERNAME_TAKEN");
    const res = await patch("  Ella.Piano ");
    expect(res.body.data.account.username).toBe("ella.piano");
    expect((await request(app).get("/api/auth/me").set("Cookie", t.cookie)).body.data.account.username).toBe("ella.piano");
    expect((await signIn("ella", PASSWORD)).res.status).toBe(401);
    expect((await signIn("ella.piano", PASSWORD)).res.status).toBe(200);
  });

  test("the super admin viewing as a teacher reads what that teacher reads, and nothing else", async () => {
    const w = await world();
    const t = await teacherIn(w);
    const as = (req) => req.set("Cookie", w.eden).set("X-Acting-As", t.id);
    const board = await as(request(app).get("/api/teacher/board"));
    expect(board.status).toBe(200);
    expect(board.body.data.cycles.map((c) => c._id)).toEqual([String(w.X._id)]);
    expect((await as(request(app).get("/api/people"))).body.code).toBe("TEACHER_APP_ONLY");
    expect((await as(request(app).get("/api/accounts"))).status).toBe(403);
    // the account stays the super admin's own: a user name is never changed for someone else from here
    expect((await as(request(app).patch("/api/auth/username")).send({ username: "eden2" })).body.code).toBe("OUT_OF_SCOPE");
    expect((await as(request(app).get("/api/auth/me"))).body.data.account.username).toBe("eden");
    // the directory: the teachers' accounts join only for the super admin, and only when asked
    const staff = (await as(request(app).get("/api/auth/staff?teachers=1"))).body.data.staff;
    expect(staff.find((a) => a._id === t.id)).toMatchObject({ kind: "teacher", person: String(w.T._id) });
    const plain = (await request(app).get("/api/auth/staff").set("Cookie", w.eden)).body.data.staff;
    expect(plain.some((a) => a.kind === "teacher")).toBe(false);
    const hagai = (await signIn("hagai")).cookie;
    const forHagai = (await request(app).get("/api/auth/staff?teachers=1").set("Cookie", hagai)).body.data.staff;
    expect(forHagai.some((a) => a.kind === "teacher")).toBe(false);
    // a disabled teacher's account is no lens and no way in
    await request(app).patch(`/api/accounts/${t.id}`).set("Cookie", w.eden).send({ active: false });
    expect((await request(app).get("/api/teacher/board").set("Cookie", t.cookie)).status).toBe(401);
    expect((await as(request(app).get("/api/teacher/board"))).status).toBe(403);
  });

  test("the month's invoice in the app: no link, his own month, the same moves; the staff's mail closes it", async () => {
    const w = await world();
    const t = await teacherIn(w);
    const month = todayStr().slice(0, 7);
    const get = (path) => request(app).get(path).set("Cookie", t.cookie);
    const send = (method, path, body) => request(app)[method](path).set("Cookie", t.cookie).send(body || {});
    // nothing is open yet: the month is offered, with how many lessons it holds
    const offered = (await get("/api/teacher/invoices")).body.data.months;
    const mine = offered.find((m) => m.month === month);
    expect(mine).toMatchObject({ requestId: null, status: "new" });
    expect(mine.counts.sessions).toBeGreaterThan(0);
    expect(await InvoiceRound.countDocuments()).toBe(0);
    // a month that is not the app's to open
    expect((await send("post", "/api/teacher/invoices", { month: "2020-01" })).body.code).toBe("INVOICE_ROUND_MONTH");
    // opening it opens the COLLEGE's round of that month, with a row for every college teacher (the tracker's list)
    const opened = await send("post", "/api/teacher/invoices", { month });
    expect(opened.status).toBe(201);
    const view = opened.body.data.view;
    expect(view).toMatchObject({ month, program: "college", done: false, closed: false, mode: "check", noRate: true });
    expect(JSON.stringify(view)).not.toMatch(/"token"|"expiresAt"|"linkLive"/);
    const round = await InvoiceRound.findOne({ program: "college", month });
    expect((await InvoiceRequest.find({ round: round._id }).distinct("teacher")).map(String).sort()).toEqual([String(w.T._id), String(w.U._id)].sort());
    // the house's course is not in it
    expect(view.courses.map((c) => String(c.cycle._id))).toEqual([String(w.X._id)]);
    const rid = view.requestId;
    // asked again: the same row
    expect((await send("post", "/api/teacher/invoices", { month })).body.data.view.requestId).toBe(rid);
    // another teacher's month reads as not there
    const other = await InvoiceRequest.findOne({ round: round._id, teacher: w.U._id });
    expect((await get(`/api/teacher/invoices/${other._id}`)).status).toBe(404);
    // reading it notes the opening (the staff see "opened"), a preview by the super admin does not
    const fresh = await InvoiceRequest.findById(rid);
    expect(fresh.openedAt).toBeFalsy();
    await request(app).get(`/api/teacher/invoices/${rid}`).set("Cookie", w.eden).set("X-Acting-As", t.id);
    expect((await InvoiceRequest.findById(rid)).openedAt).toBeFalsy();
    await get(`/api/teacher/invoices/${rid}`);
    expect((await InvoiceRequest.findById(rid)).openedAt).toBeTruthy();

    // the picture goes straight to the bucket, then is confirmed with the lessons it is for
    const sessions = view.courses[0].sessions.map((x) => x._id);
    const begin = await send("post", `/api/teacher/invoices/${rid}/upload-url`, { name: "nov.png", mime: "image/png", size: PNG.length });
    expect(begin.status).toBe(201);
    await storage.uploadTo(begin.body.data.put, PNG);
    // a checked month asks the number and the sum of every invoice
    expect((await send("post", `/api/teacher/invoices/${rid}/uploads/${begin.body.data.fileId}/confirm`, { sessions: [sessions[0]] })).body.code).toBe("INVOICE_AMOUNT_REQUIRED");
    const again = await send("post", `/api/teacher/invoices/${rid}/upload-url`, { name: "nov.png", mime: "image/png", size: PNG.length });
    await storage.uploadTo(again.body.data.put, PNG);
    begin.body.data.fileId = again.body.data.fileId;
    // a file id that is not his own upload
    expect((await send("post", `/api/teacher/invoices/${rid}/uploads/6ad6000000000000000000aa/confirm`, { sessions: [sessions[0]] })).status).toBe(404);
    const done = await send("post", `/api/teacher/invoices/${rid}/uploads/${begin.body.data.fileId}/confirm`, { sessions: [sessions[0]], number: "1041", amount: 180 });
    expect(done.status).toBe(200);
    const inv = done.body.data.view.invoices[0];
    expect(inv).toMatchObject({ number: "1041", amount: 180 });
    expect(done.body.data.view.counts.billed).toBe(1);
    expect((await get(`/api/teacher/invoices/${rid}/invoices/${inv._id}/image`)).status).toBe(302);
    // the number corrected; the list says where the month stands
    expect((await send("patch", `/api/teacher/invoices/${rid}/invoices/${inv._id}`, { number: "1042", amount: 180 })).body.data.view.invoices[0].number).toBe("1042");
    expect((await get("/api/teacher/invoices")).body.data.months.find((m) => m.month === month)).toMatchObject({ requestId: rid, status: "partial", invoices: 1, invoiced: 180 });
    // the staff's own opening of a college month makes checked rows too
    expect((await InvoiceRequest.find({ round: round._id }).distinct("mode")).sort()).toEqual(["check"]);
    // with a rate on file the sum is measured against the hours: a difference asks its reason, and never stops the invoice
    const { Profile } = require("../../../models/profiles");
    await Profile.updateOne({ person: w.T._id, kind: "Teacher" }, { hourlyRate: 100 });
    const rated = (await get(`/api/teacher/invoices/${rid}`)).body.data.view;
    expect(rated.rate).toMatchObject({ kind: "hour", value: 100 });
    expect(rated.noRate).toBeUndefined();
    const up2 = await send("post", `/api/teacher/invoices/${rid}/upload-url`, { name: "b.png", mime: "image/png", size: PNG.length });
    await storage.uploadTo(up2.body.data.put, PNG);
    const off = { sessions: [sessions[1]], number: "1043", amount: 200 }; // 45 minutes at 100 ₪ an hour = 75 ₪
    expect((await send("post", `/api/teacher/invoices/${rid}/uploads/${up2.body.data.fileId}/confirm`, off)).body.code).toBe("INVOICE_EXPLAIN_REQUIRED");
    const up3 = await send("post", `/api/teacher/invoices/${rid}/upload-url`, { name: "b.png", mime: "image/png", size: PNG.length });
    await storage.uploadTo(up3.body.data.put, PNG);
    const said = await send("post", `/api/teacher/invoices/${rid}/uploads/${up3.body.data.fileId}/confirm`, { ...off, reason: "expenses", explanation: "נסיעות" });
    expect(said.status).toBe(200);
    expect(said.body.data.view.invoices.find((i) => i.number === "1043").check).toMatchObject({ verdict: "high", expected: 75 });
    // finished: no more changes from the app
    expect((await send("post", `/api/teacher/invoices/${rid}/done`, {})).body.data.view.done).toBe(true);
    expect((await send("delete", `/api/teacher/invoices/${rid}/invoices/${inv._id}`)).body.code).toBe("INVOICE_LINK_DONE");
    // the staff see it on their side (the college manager's rounds), and their mail closes the month for the app
    const hagai = (await signIn("hagai")).cookie;
    const list = (await request(app).get("/api/invoice-rounds").set("Cookie", hagai)).body.data.rounds;
    expect(list.map((r) => r.month)).toEqual([month]);
    expect(JSON.stringify(list)).not.toMatch(/"token"/);
    await rounds.reopen({ roundId: round._id, requestId: rid });
    await rounds.setMail({ roundId: round._id, sent: true, by: "חגי" });
    expect((await send("post", `/api/teacher/invoices/${rid}/done`, {})).body.code).toBe("INVOICE_MONTH_CLOSED");
    expect((await get(`/api/teacher/invoices/${rid}`)).body.data.view.closed).toBe(true);
  });

  test("a college manager who opens a month with no program named opens the college's", async () => {
    const w = await world();
    const hagai = (await signIn("hagai")).cookie;
    const res = await request(app).post("/api/invoice-rounds").set("Cookie", hagai).send({ month: todayStr().slice(0, 7) });
    expect(res.status).toBe(201);
    expect(res.body.data.round.program).toBe("college");
    expect(w.T).toBeTruthy();
  });
});
