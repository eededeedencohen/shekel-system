/**
 * The lens inside the open routers (services/lensService, Eden 2026-10-18):
 * a persona reads and touches only the rows of its own program - people,
 * cycles, seats, lessons, intake files, the record, invoices - the same
 * lines the client's PersonaContext draws. The super admin and the social
 * worker see everything; the super admin viewing as someone is that
 * someone.
 *
 * Runs with AUTH_ENFORCE=1 so req.actor is the real persona.
 */

const request = require("supertest");
const mongoose = require("mongoose");
const app = require("../../../app");
const { ensureSeedAccounts } = require("../../../services/authService");
const { defaultPasswordFor } = require("../../../utils/password");
const { createPersonWithProfile } = require("../../../services/profileService");
const tags = require("../../../services/tagService");
const activities = require("../../../services/activityService");
const invoices = require("../../../services/invoiceService");
const { makeStudent, makeTeacher, makeCycle, makeHostel, makeEnrollment, makeLesson, makeCultureStudent, makeCultureStaff } = require("../../helpers/factories");

beforeAll(() => {
  process.env.AUTH_ENFORCE = "1";
});
afterAll(() => {
  delete process.env.AUTH_ENFORCE;
});

const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const signIn = async (username) => cookieOf(await request(app).post("/api/auth/login").send({ username, password: defaultPasswordFor(username) }));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const ids = (rows) => rows.map((r) => String(r._id));

/**
 * One world with everyone in it:
 *   A  a college student            C  a culture student         T  a teacher (shared)
 *   H  a college student in the hostels (the hostels tag)        S  culture staff
 *   M  a hostel manager              X  a college cycle of T      Y  a hostel cycle of T
 *   eA A sits in X, eH H sits in Y;  lX / lY one lesson each
 */
async function world() {
  const hostel = await makeHostel();
  const [A, H, C, T, S] = await Promise.all([makeStudent(), makeStudent(), makeCultureStudent(), makeTeacher(), makeCultureStaff()]);
  await tags.give({ world: "real", personId: H._id, key: "hostels", by: "בדיקה" });
  const { person: M } = await createPersonWithProfile("ManagerHostel", { firstName: "מנהל", lastName: "הוסטל", email: `hm_${Date.now()}@test.local`, hostels: [hostel._id] }, { trusted: true });
  const X = await makeCycle({ teacher: T._id });
  const Y = await makeCycle({ teacher: T._id, hostel: hostel._id });
  const eA = await makeEnrollment({ cycle: X._id, student: A._id });
  const eH = await makeEnrollment({ cycle: Y._id, student: H._id });
  const lX = await makeLesson({ cycle: X._id, date: new Date("2026-03-10T00:00:00.000Z") });
  const lY = await makeLesson({ cycle: Y._id, date: new Date("2026-03-11T00:00:00.000Z") });
  return { hostel, A, H, C, T, S, M, X, Y, eA, eH, lX, lY };
}

describe("the lens - a persona's own rows and nothing of another program's", () => {
  let w;
  const c = {};
  beforeEach(async () => {
    await ensureSeedAccounts();
    for (const u of ["eden", "hagai", "yetav", "tamar", "shiran"]) c[u] = await signIn(u);
    w = await world();
  });
  const get = (user, path) => request(app).get(path).set("Cookie", c[user]);
  const expectIds = (res, has, not) => {
    expect(res.status).toBe(200);
    const got = ids(Object.values(res.body.data)[0]);
    for (const p of has) expect(got).toContain(String(p._id));
    for (const p of not) expect(got).not.toContain(String(p._id));
  };

  it("people: the college gets its students and the teachers, the hostels its people and the teachers, the culture its own", async () => {
    const { A, H, C, T, S, M } = w;
    expectIds(await get("hagai", "/api/people"), [A, H, T], [C, S, M]);
    expectIds(await get("tamar", "/api/people"), [H, T, M], [A, C, S]);
    expectIds(await get("shiran", "/api/people"), [C, S], [A, H, T, M]);
    expectIds(await get("yetav", "/api/people"), [A, H, C, T, S, M], []);
    expectIds(await get("eden", "/api/people"), [A, H, C, T, S, M], []);
  });

  it("one person: 403 OUT_OF_SCOPE outside the lens, 404 when there is no such person, teachers shared", async () => {
    const { A, C, T } = w;
    const out = await get("hagai", `/api/people/${C._id}`);
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("OUT_OF_SCOPE");
    expect((await get("hagai", `/api/people/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    expect((await request(app).put(`/api/people/${A._id}`).set("Cookie", c.shiran).send({ firstName: "x" })).status).toBe(403);
    expect((await get("shiran", `/api/people/${A._id}/programs`)).status).toBe(403);
    expect((await get("tamar", `/api/people/${A._id}/enrollments`)).status).toBe(403);
    // the teacher is both college lenses' - the hostels coordinator marks a window, the manager reads the page
    expect((await request(app).patch(`/api/people/${T._id}/availability`).set("Cookie", c.tamar).send({ availability: [{ day: 1, start: "10:00", end: "12:00", program: "hostels" }] })).status).toBe(200);
    expect((await get("hagai", `/api/people/${T._id}`)).status).toBe(200);
  });

  it("cycles: hostel cycles for the hostels lens, college ones for the manager - by id, on a write, on a create", async () => {
    const { X, Y } = w;
    expectIds(await get("hagai", "/api/cycles"), [X], [Y]);
    expectIds(await get("tamar", "/api/cycles"), [Y], [X]);
    expectIds(await get("yetav", "/api/cycles"), [X, Y], []);
    expect((await get("hagai", `/api/cycles/${Y._id}`)).status).toBe(403);
    expect((await get("tamar", `/api/cycles/${X._id}`)).status).toBe(403);
    expect((await request(app).put(`/api/cycles/${X._id}`).set("Cookie", c.tamar).send({ status: "Active" })).status).toBe(403);
    // a cycle may not change sides, and a new one is born on the persona's side
    expect((await request(app).put(`/api/cycles/${Y._id}`).set("Cookie", c.tamar).send({ hostel: null })).status).toBe(403);
    const body = { subject: X.subject, startDate: "2026-09-01", endDate: "2026-12-31", schedule: [{ day: 1, start: "10:00", end: "11:00" }] };
    expect((await request(app).post("/api/cycles").set("Cookie", c.tamar).send(body)).status).toBe(403);
    expect((await request(app).post("/api/cycles").set("Cookie", c.hagai).send({ ...body, hostel: w.hostel._id })).status).toBe(403);
    expect((await request(app).post("/api/cycles").set("Cookie", c.tamar).send({ ...body, hostel: w.hostel._id })).status).toBe(201);
    expect((await request(app).post("/api/cycles").set("Cookie", c.hagai).send(body)).status).toBe(201);
    // the track query cannot cross the lens (Y and the hostel cycle tamar just made are hers; nothing is hagai's)
    expect((await get("hagai", "/api/cycles?track=hostel")).body.results).toBe(0);
    expect((await get("hagai", `/api/cycles?hostel=${w.hostel._id}`)).body.results).toBe(0);
    expect((await get("tamar", `/api/cycles?hostel=${w.hostel._id}`)).body.results).toBe(2);
    expect((await get("tamar", "/api/cycles?track=college")).body.results).toBe(0);
  });

  it("seats and lessons follow their cycle", async () => {
    const { X, Y, H, eA, eH, lX, lY } = w;
    expectIds(await get("hagai", "/api/enrollments"), [eA], [eH]);
    expectIds(await get("tamar", "/api/enrollments"), [eH], [eA]);
    expect((await get("hagai", `/api/enrollments?cycle=${Y._id}`)).status).toBe(403);
    expect((await request(app).post("/api/enrollments").set("Cookie", c.hagai).send({ cycle: Y._id, student: H._id })).status).toBe(403);
    expect((await request(app).patch(`/api/enrollments/${eH._id}`).set("Cookie", c.hagai).send({ note: "x" })).status).toBe(403);
    expectIds(await get("hagai", "/api/lessons?from=2026-03-01&to=2026-03-31"), [lX], [lY]);
    expectIds(await get("tamar", "/api/lessons?from=2026-03-01&to=2026-03-31"), [lY], [lX]);
    expectIds(await get("eden", "/api/lessons?from=2026-03-01&to=2026-03-31"), [lX, lY], []);
    expect((await get("hagai", `/api/lessons?cycle=${Y._id}`)).status).toBe(403);
    expect((await get("hagai", `/api/lessons/${lY._id}`)).status).toBe(403);
    expect((await request(app).put("/api/lessons/attendance").set("Cookie", c.hagai).send({ cycle: Y._id, date: "2026-03-12", records: [] })).status).toBe(403);
    expect((await request(app).put("/api/lessons/attendance").set("Cookie", c.tamar).send({ cycle: Y._id, date: "2026-03-12", records: [] })).status).toBe(200);
    expect((await request(app).put("/api/lessons/attendance").set("Cookie", c.hagai).send({ cycle: X._id, date: "2026-03-12", records: [] })).status).toBe(200);
  });

  it("intake files and the record belong to the person's lens", async () => {
    const { A, H, C } = w;
    const open = (user, person) => request(app).post("/api/intakes/open").set("Cookie", c[user]).send({ person: person._id, by: "בדיקה" });
    const iA = (await open("eden", A)).body.data.intake;
    const iC = (await open("eden", C)).body.data.intake;
    await open("eden", H);
    expectIds(await get("hagai", "/api/intakes"), [iA], [iC]);
    expectIds(await get("shiran", "/api/intakes"), [iC], [iA]);
    expect((await get("tamar", "/api/intakes")).body.data.intakes.map((i) => String(i.person._id))).toEqual([String(H._id)]);
    expect((await open("hagai", C)).status).toBe(403);
    expect((await get("hagai", `/api/intakes/person/${C._id}`)).status).toBe(403);
    expect((await get("hagai", `/api/intakes/${iC._id}`)).status).toBe(403);
    expect((await get("shiran", `/api/intakes/${iC._id}`)).status).toBe(200);

    const rowA = await activities.addActivity({ world: "real", person: A._id, kind: "update", by: "בדיקה", body: "א", skipRequired: true });
    const rowC = await activities.addActivity({ world: "real", person: C._id, kind: "update", by: "בדיקה", body: "ג", skipRequired: true });
    expectIds(await get("hagai", "/api/activities"), [rowA], [rowC]);
    expectIds(await get("shiran", "/api/activities"), [rowC], [rowA]);
    expectIds(await get("yetav", "/api/activities"), [rowA, rowC], []);
    expect((await get("hagai", `/api/activities?person=${C._id}`)).body.results).toBe(0);
    expect((await request(app).post("/api/activities").set("Cookie", c.hagai).send({ person: C._id, kind: "update", by: "x" })).status).toBe(403);
    expect((await request(app).patch(`/api/activities/${rowC._id}`).set("Cookie", c.hagai).send({ body: "x" })).status).toBe(403);
    expect((await request(app).post("/api/incidents").set("Cookie", c.hagai).send({ person: C._id })).status).toBe(403);
    expect((await get("hagai", "/api/incidents")).status).toBe(200);
  });

  it("invoices: a teacher's invoice shows on the side its lessons are on", async () => {
    const { T, lX, lY } = w;
    const inv = await invoices.createInvoice({ world: "real", teacherId: T._id, lessonIds: [lX._id], imageData: PNG, by: "בדיקה" });
    expect(ids((await get("hagai", "/api/invoices")).body.data.invoices)).toContain(String(inv._id));
    expect(ids((await get("tamar", "/api/invoices")).body.data.invoices)).not.toContain(String(inv._id));
    expect((await get("tamar", `/api/invoices/${inv._id}`)).status).toBe(403);
    expect((await get("hagai", `/api/invoices/${inv._id}`)).status).toBe(200);
    expect(ids((await get("tamar", `/api/invoices/lessons?teacher=${T._id}`)).body.data.lessons)).toEqual([String(lY._id)]);
    expect(ids((await get("hagai", `/api/invoices/lessons?teacher=${T._id}`)).body.data.lessons)).toEqual([String(lX._id)]);
    // a hostels invoice may not bill a college lesson
    const forged = await request(app).post("/api/invoices").set("Cookie", c.tamar).send({ teacher: T._id, lessons: [lY._id, lX._id], imageData: PNG, by: "x" });
    expect(forged.status).toBe(403);
  });

  it("a new belonging is of the persona's own program", async () => {
    const { A, H } = w;
    const lead = { firstName: "ליד", lastName: "חדש", department: "StudentCulture" };
    expect((await request(app).post("/api/people/intake").set("Cookie", c.hagai).send(lead)).status).toBe(403);
    expect((await request(app).post("/api/people/intake").set("Cookie", c.shiran).send(lead)).status).toBe(201);
    expect((await request(app).post("/api/people/intake").set("Cookie", c.shiran).send({ ...lead, department: "StudentCollege" })).status).toBe(403);
    // the hostels tag is the hostels coordinator's to give - on her own people; a manager gives no hostels
    expect((await request(app).post(`/api/tags/people/${H._id}`).set("Cookie", c.hagai).send({ key: "hostels" })).status).toBe(403);
    expect((await request(app).post(`/api/tags/people/${A._id}`).set("Cookie", c.tamar).send({ key: "hostels" })).status).toBe(403);
    expect((await request(app).post(`/api/tags/people/${A._id}`).set("Cookie", c.yetav).send({ key: "hostels" })).status).toBe(200);
    // a transfer lands in a program the persona has
    const move = { from: "StudentCollege", to: "StudentCulture", by: "x" };
    expect((await request(app).post(`/api/people/${A._id}/transfer`).set("Cookie", c.hagai).send(move)).status).toBe(403);
    expect((await request(app).post(`/api/people/${A._id}/transfer`).set("Cookie", c.yetav).send(move)).status).toBe(200);
  });

  it("the super admin viewing as someone is that someone", async () => {
    const { A, H, T, C, S, M } = w;
    const staff = (await get("eden", "/api/auth/staff")).body.data.staff;
    const tamar = staff.find((a) => a.kind === "hostels");
    const as = (path) => request(app).get(path).set("Cookie", c.eden).set("X-Acting-As", String(tamar._id));
    expectIds(await as("/api/people"), [H, T, M], [A, C, S]);
    expect((await as(`/api/people/${A._id}`)).status).toBe(403);
    expectIds(await get("eden", "/api/people"), [A, H, T, C, S, M], []);
  });
});
