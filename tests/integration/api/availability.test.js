/**
 * A teacher's availability marked per program (Eden, 2026-10-14): the
 * hostels coordinator marks for the hostels, the college managers for
 * מכללה לכל, the teacher (the teachers' app) for nobody in particular. A
 * window one program marked is shut to the other: no overlap, no change.
 *
 * Runs with AUTH_ENFORCE=1 so req.actor is the real persona.
 */

const request = require("supertest");
const app = require("../../../app");
const { ensureSeedAccounts } = require("../../../services/authService");
const { defaultPasswordFor } = require("../../../utils/password");
const { makeTeacher } = require("../../helpers/factories");

beforeAll(() => {
  process.env.AUTH_ENFORCE = "1";
});
afterAll(() => {
  delete process.env.AUTH_ENFORCE;
});

const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const signIn = async (username) => cookieOf(await request(app).post("/api/auth/login").send({ username, password: defaultPasswordFor(username) }));
const patch = (cookie, id, availability) => request(app).patch(`/api/people/${id}/availability`).set("Cookie", cookie).send({ availability });
const win = (day, start, end, program) => ({ day, start, end, program });

describe("PATCH /api/people/:id/availability - program-marked windows", () => {
  let tamar;
  let hagai;
  let eden;
  beforeEach(async () => {
    await ensureSeedAccounts();
    tamar = await signIn("tamar");
    hagai = await signIn("hagai");
    eden = await signIn("eden");
  });

  it("stores the program of a window; an unknown program is nobody's", async () => {
    const t = await makeTeacher();
    const res = await patch(tamar, t._id, [win(1, "10:00", "12:00", "hostels"), win(2, "10:00", "11:00", "junk"), { day: 3, start: "09:00", end: "10:00" }]);
    expect(res.status).toBe(200);
    const av = res.body.data.person.availability;
    expect(av.map((w) => w.program)).toEqual(["hostels", null, null]);
  });

  it("refuses a window of one program over a window of the other", async () => {
    const t = await makeTeacher();
    expect((await patch(tamar, t._id, [win(1, "10:00", "12:00", "hostels")])).status).toBe(200);
    const clash = await patch(hagai, t._id, [win(1, "10:00", "12:00", "hostels"), win(1, "11:00", "13:00", "college")]);
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("AVAILABILITY_TAKEN");
    // beside it is fine
    const beside = await patch(hagai, t._id, [win(1, "10:00", "12:00", "hostels"), win(1, "12:00", "14:00", "college")]);
    expect(beside.status).toBe(200);
    expect(beside.body.data.person.availability).toHaveLength(2);
  });

  it("the other program's windows are locked: a college manager may not drop or move the hostels' one", async () => {
    const t = await makeTeacher();
    await patch(tamar, t._id, [win(1, "10:00", "12:00", "hostels")]);
    const dropped = await patch(hagai, t._id, [win(2, "10:00", "12:00", "college")]);
    expect(dropped.status).toBe(403);
    expect(dropped.body.code).toBe("AVAILABILITY_LOCKED");
    const moved = await patch(hagai, t._id, [win(1, "10:00", "11:00", "hostels")]);
    expect(moved.status).toBe(403);
    // and the hostels coordinator may not mark for the college
    const forged = await patch(tamar, t._id, [win(1, "10:00", "12:00", "hostels"), win(3, "10:00", "12:00", "college")]);
    expect(forged.status).toBe(403);
    // the super admin may do anything
    const free = await patch(eden, t._id, [win(2, "10:00", "12:00", "college")]);
    expect(free.status).toBe(200);
    expect(free.body.data.person.availability[0].program).toBe("college");
  });

  it("a window the teacher marked is nobody's - a program may take it", async () => {
    const t = await makeTeacher({ availability: [{ day: 0, start: "08:00", end: "12:00" }] });
    const res = await patch(tamar, t._id, [win(0, "08:00", "12:00", "hostels")]);
    expect(res.status).toBe(200);
    expect(res.body.data.person.availability[0].program).toBe("hostels");
  });
});
