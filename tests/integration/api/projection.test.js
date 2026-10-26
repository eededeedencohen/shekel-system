/**
 * Stage 4b of the hardening plan (2026-10-26, section 9-ב): the secrets of
 * the public links - an intake's personal token, a supplier's link token,
 * an invoice request's and a hostel report's - never ride in the staff's
 * JSON (lists or single reads). The staff who need a link ask its own
 * route and get the whole address; a foreign family gets 403.
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { makeTeacher, makeStudent, makeHostel, makeCycle, makeSubject } = require("../../helpers/factories");
const tags = require("../../../services/tagService");

const actAs = ({ kind = "super", person = null } = {}) => {
  TEST_ACCOUNT.kind = kind;
  TEST_ACCOUNT.person = person;
};
afterEach(() => actAs());

const noTokenDeep = (x, path = "") => {
  if (!x || typeof x !== "object") return [];
  if (Array.isArray(x)) return x.flatMap((v, i) => noTokenDeep(v, `${path}[${i}]`));
  return Object.entries(x).flatMap(([k, v]) => (k === "token" && v ? [`${path}.${k}`] : noTokenDeep(v, `${path}.${k}`)));
};

describe("tokens stay on the server", () => {
  it("an intake: no landing token in the list or the record; GET /:id/link hands the personal link while it lives", async () => {
    const joined = await request(app).post("/api/public/join").send({ firstName: "דנה", lastName: "לוי", phone: "0521234567", programs: ["StudentCulture"] });
    expect(joined.status).toBe(201);
    const { intakeId, token } = joined.body.data;
    expect(token).toBeTruthy(); // the public page itself needs it

    const list = await request(app).get("/api/intakes");
    const row = list.body.data.intakes.find((i) => i._id === intakeId);
    expect(row.landing.hasToken).toBe(true);
    expect(row.landing.token).toBeUndefined();
    expect(noTokenDeep(list.body)).toEqual([]);
    const one = await request(app).get(`/api/intakes/${intakeId}`);
    expect(one.body.data.intake.landing.token).toBeUndefined();

    const link = await request(app).get(`/api/intakes/${intakeId}/link`);
    expect(link.status).toBe(200);
    expect(link.body.data.link).toMatchObject({ token, live: true });
    expect(link.body.data.link.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/join/docs/${token}$`));
    expect((await request(app).get("/api/intakes/000000000000000000000000/link")).status).toBe(404);
  });

  it("a supplier: no link token in the list or the card; GET /:id/link hands it to the hostels coordinator, never to the culture coordinator", async () => {
    const made = await request(app).post("/api/suppliers").send({ firstName: "תמר", lastName: "ספקית", gender: "female", phone: "0500000000", days: 7 });
    expect(made.status).toBe(201);
    const s = made.body.data.supplier;
    expect(s.link.hasToken).toBe(true);
    expect(s.link.token).toBeUndefined();
    expect(noTokenDeep((await request(app).get("/api/suppliers")).body)).toEqual([]);
    actAs({ kind: "hostels" });
    const link = await request(app).get(`/api/suppliers/${s._id}/link`);
    expect(link.status).toBe(200);
    expect(link.body.data.link.token).toMatch(/^[\w-]{20,}$/);
    expect(link.body.data.link.url).toMatch(new RegExp(`/supplier/${link.body.data.link.token}$`));
    expect(link.body.data.link.live).toBe(true);
    actAs({ kind: "culture" });
    expect((await request(app).get(`/api/suppliers/${s._id}/link`)).status).toBe(403);
  });

  it("an invoice round and a hostel report: no request or report token in the lists; their link routes hand the address", async () => {
    const hostel = await makeHostel({ contacts: [{ name: "גילי", role: "reporter", phone: "052-0000000" }] });
    const teacher = await makeTeacher();
    const subject = await makeSubject({ name: "קרמיקה" });
    const cycle = await makeCycle({ subject: subject._id, teacher: teacher._id, hostel: hostel._id, startDate: new Date("2026-01-01"), endDate: new Date("2027-07-31"), schedule: [{ day: 1, start: "10:00", end: "11:00" }] });
    await tags.setCycleProgram({ cycleId: cycle._id, key: "hostels" });
    const resident = await makeStudent({ residence: { hostel: hostel._id, since: new Date("2026-01-01") } });
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: resident._id });
    const last = new Date();
    last.setMonth(last.getMonth() - 1);
    const month = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;

    const round = await request(app).post("/api/invoice-rounds").send({ month, program: "hostels" });
    expect(round.status).toBe(201);
    const req0 = round.body.data.round.requests.find((r) => String(r.teacher._id) === String(teacher._id));
    expect(req0.hasToken).toBe(true);
    expect(req0.token).toBeUndefined();
    expect(noTokenDeep((await request(app).get("/api/invoice-rounds")).body)).toEqual([]);
    const rl = await request(app).get(`/api/invoice-rounds/${round.body.data.round._id}/requests/${req0._id}/link`);
    expect(rl.status).toBe(200);
    expect(rl.body.data.link.url).toMatch(new RegExp(`/invoices/${rl.body.data.link.token}$`));
    expect(rl.body.data.link.live).toBe(true);
    // the public page opens on exactly that token
    expect((await request(app).get(`/api/public/invoices/${rl.body.data.link.token}`)).status).toBe(200);

    const opened = await request(app).post("/api/hostel-reports").send({ month });
    expect(opened.status).toBe(201);
    const report = opened.body.data.reports.find((r) => String(r.hostel._id) === String(hostel._id));
    expect(report.hasToken).toBe(true);
    expect(report.token).toBeUndefined();
    expect(noTokenDeep((await request(app).get("/api/hostel-reports")).body)).toEqual([]);
    const hl = await request(app).get(`/api/hostel-reports/${report._id}/link`);
    expect(hl.status).toBe(200);
    expect(hl.body.data.link.url).toMatch(new RegExp(`/hostel-report/${hl.body.data.link.token}$`));
    expect((await request(app).get(`/api/public/hostel-reports/${hl.body.data.link.token}`)).status).toBe(200);
    // the culture coordinator has none of this
    actAs({ kind: "culture" });
    expect((await request(app).get(`/api/hostel-reports/${report._id}/link`)).status).toBe(403);
    expect((await request(app).get(`/api/invoice-rounds/${round.body.data.round._id}/requests/${req0._id}/link`)).status).toBe(403);
  });
});
