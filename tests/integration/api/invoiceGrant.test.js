/**
 * The "invoices" grant (Eden, 2026-11-18: "תן לשמרית את האפשרות לעקוב אחרי
 * חשבוניות של מורים. למעשה שיהיה לה הרשאות לחשבוניות כמו שיש לי"): the
 * hostels coordinator alone sees and opens the hostels' rounds; with the
 * grant she sees, opens and corrects every program's - like the super
 * admin. The bypass actor's kind and features are borrowed (TEST_ACCOUNT).
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { STAFF_FEATURE_KEYS } = require("../../../utils/domain");
const tags = require("../../../services/tagService");
const { makeTeacher, makeHostel, makeCycle, makeSubject } = require("../../helpers/factories");

afterEach(() => {
  TEST_ACCOUNT.kind = "super";
  delete TEST_ACCOUNT.features;
});

/** October 2026: a teacher of a hostel course, another of a college course. */
async function twoPrograms() {
  const hostel = await makeHostel({ name: "שיירות" });
  const subject = await makeSubject({ name: "עיצוב גרפי" });
  const avia = await makeTeacher({ firstName: "אביה", lastName: "הוסטלים" });
  const noa = await makeTeacher({ firstName: "נעה", lastName: "מכללה" });
  const span = { startDate: new Date("2026-09-01"), endDate: new Date("2026-12-31") };
  const inHostel = await makeCycle({ subject: subject._id, teacher: avia._id, hostel: hostel._id, ...span, schedule: [{ day: 4, start: "15:00", end: "16:00" }] });
  await tags.setCycleProgram({ cycleId: inHostel._id, key: "hostels" });
  await makeCycle({ teacher: noa._id, ...span, schedule: [{ day: 1, start: "10:00", end: "11:00" }] });
  return { avia, noa };
}
const rounds = async () => (await request(app).get("/api/invoice-rounds")).body.data.rounds.map((r) => `${r.month} ${r.program}`).sort();
const open = (body) => request(app).post("/api/invoice-rounds").send(body);
const admin = (id, body) => request(app).post(`/api/invoice-rounds/${id}/admin`).send(body);

describe("the invoices grant", () => {
  it("is a grant the users page can give", () => {
    expect(STAFF_FEATURE_KEYS).toContain("invoices");
  });

  it("the hostels coordinator without it: her own program's rounds only, and no corrections", async () => {
    await twoPrograms();
    const hostels = (await open({ month: "2026-10", program: "hostels" })).body.data.round;
    const college = (await open({ month: "2026-10", program: "college" })).body.data.round;
    expect(await rounds()).toEqual(["2026-10 college", "2026-10 hostels"]);

    TEST_ACCOUNT.kind = "hostels";
    expect(await rounds()).toEqual(["2026-10 hostels"]);
    expect((await request(app).get(`/api/invoice-rounds/${college._id}`)).body.code).toBe("OUT_OF_SCOPE");
    expect((await open({ month: "2026-11", program: "college" })).body.code).toBe("OUT_OF_SCOPE");
    const refused = await admin(hostels._id, { action: "requestsSync", dryRun: true });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("AUTH_FORBIDDEN");
  });

  it("with it: every program's rounds are hers to see, to open and to correct - like the super admin", async () => {
    await twoPrograms();
    const hostels = (await open({ month: "2026-10", program: "hostels" })).body.data.round;
    const college = (await open({ month: "2026-10", program: "college" })).body.data.round;

    TEST_ACCOUNT.kind = "hostels";
    TEST_ACCOUNT.features = ["invoices"];
    expect(await rounds()).toEqual(["2026-10 college", "2026-10 hostels"]);
    const seen = await request(app).get(`/api/invoice-rounds/${college._id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.round.requests[0].teacher.firstName).toBe("נעה");
    // the link of a college teacher, the note, the ledger: the whole coordinator's side
    const req0 = seen.body.data.round.requests[0];
    expect((await request(app).get(`/api/invoice-rounds/${college._id}/requests/${req0._id}/link`)).body.data.link.token).toMatch(/^[\w-]{12,}$/);
    expect((await request(app).get(`/api/invoice-rounds/${college._id}/ledger.xlsx`)).status).toBe(200);
    // a round of the other program is opened by her
    const next = await open({ month: "2026-11", program: "college" });
    expect(next.status).toBe(201);
    expect(next.body.data.round.program).toBe("college");
    // the corrections, on both programs
    for (const r of [hostels, college]) {
      const did = await admin(r._id, { action: "requestsSync" });
      expect(did.status).toBe(200);
      expect(did.body.data.did.requests).toBe(0);
    }
    // the invoices list is every program's too
    expect((await request(app).get("/api/invoices")).status).toBe(200);

    // the grant is of the account: the college manager without it stays on the college's side
    TEST_ACCOUNT.kind = "manager";
    delete TEST_ACCOUNT.features;
    expect(await rounds()).toEqual(["2026-10 college", "2026-11 college"]);
    expect((await admin(college._id, { action: "requestsSync" })).status).toBe(403);
  });
});
