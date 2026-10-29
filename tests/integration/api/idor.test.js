/**
 * Stage 4c of the hardening plan (2026-10-27, appendix A-3): a write on a
 * record outside the persona's program is refused and leaves the record as
 * it was - a profile of the other program on a person in two programs, a
 * transfer whose `from` side the persona lacks, the record's templates for
 * anyone but the super admin and the social worker - and an id that is no
 * id is a 404 at once, never a skipped check.
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { Profile } = require("../../../models/profiles");
const { makeStudent, makeCycle } = require("../../helpers/factories");

const actAs = ({ kind = "super", person = null } = {}) => {
  TEST_ACCOUNT.kind = kind;
  TEST_ACCOUNT.person = person;
};
afterEach(() => actAs());

/** A college student who is also in תרבות לכל: the manager sees the person, not the culture profile. */
async function dualStudent() {
  const s = await makeStudent();
  const res = await request(app).post(`/api/people/${s._id}/profiles`).send({ kind: "StudentCulture" });
  expect(res.status).toBe(201);
  return { person: s, college: s.profile, culture: res.body.data.profile };
}

describe("a profile write must be of the persona's own program", () => {
  it("the college manager may not edit, close, move or leave the culture profile of a student in both programs; the college one is hers", async () => {
    const { person, college, culture } = await dualStudent();
    actAs({ kind: "manager" });
    const patch = await request(app).patch(`/api/profiles/${culture._id}`).send({ notes: "שלי" });
    expect(patch.status).toBe(403);
    expect(patch.body.code).toBe("OUT_OF_SCOPE");
    expect((await request(app).post(`/api/profiles/${culture._id}/close`).send({ note: "סגירה" })).status).toBe(403);
    expect((await request(app).post(`/api/profiles/${culture._id}/stage`).send({ stage: "Placed" })).status).toBe(403);
    expect((await request(app).post(`/api/profiles/${culture._id}/leave`).send({ leftAt: "2026-10-01", reason: "other" })).status).toBe(403);
    expect((await request(app).delete(`/api/profiles/${culture._id}`)).status).toBe(403);
    // the old person-addressed stage move, pointed at the culture profile
    expect((await request(app).post(`/api/people/${person._id}/stage`).send({ stage: "Placed", kind: "StudentCulture" })).status).toBe(403);
    const untouched = await Profile.findById(culture._id);
    expect(untouched.active).toBe(true);
    expect(untouched.notes).toBeUndefined();
    expect(untouched.pipeline.stage).toBe("Interested");
    // reading is not a write: the person is in her lens
    expect((await request(app).get(`/api/profiles/${culture._id}`)).status).toBe(200);
    // her own program's profile answers
    expect((await request(app).patch(`/api/profiles/${college._id}`).send({ notes: "שלי" })).status).toBe(200);
    // the social worker and the super admin see both programs
    actAs({ kind: "social" });
    expect((await request(app).patch(`/api/profiles/${culture._id}`).send({ notes: "עו\"ס" })).status).toBe(200);
  });

  it("a transfer needs BOTH sides to be the persona's programs", async () => {
    const { person } = await dualStudent();
    actAs({ kind: "manager" });
    const out = await request(app).post(`/api/people/${person._id}/transfer`).send({ from: "StudentCulture", to: "StudentCollege" });
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("OUT_OF_SCOPE");
    expect((await Profile.findOne({ person: person._id, kind: "StudentCulture" })).active).toBe(true);
    actAs({ kind: "social" });
    const ok = await request(app).post(`/api/people/${person._id}/transfer`).send({ from: "StudentCulture", to: "StudentCollege", note: "חזרה למכללה" });
    // the student already holds the college profile: the service answers for that case, the gate let it through
    expect([200, 400, 409]).toContain(ok.status);
    expect(ok.body.code).not.toBe("OUT_OF_SCOPE");
  });
});

describe("the record's templates", () => {
  it("are read by everyone and changed by the super admin and the social worker alone", async () => {
    actAs({ kind: "manager" });
    expect((await request(app).get("/api/activities/templates/followUp")).status).toBe(200);
    const put = await request(app).put("/api/activities/templates/followUp").send({ title: "שיחה", body: "x", fields: [] });
    expect(put.status).toBe(403);
    expect(put.body.code).toBe("AUTH_FORBIDDEN");
    expect((await request(app).delete("/api/activities/templates/followUp")).status).toBe(403);
    actAs({ kind: "hostels" });
    expect((await request(app).put("/api/activities/templates/followUp").send({ title: "שיחה", body: "x", fields: [] })).status).toBe(403);
    actAs({ kind: "social" });
    const ok = await request(app).put("/api/activities/templates/followUp").send({ title: "שיחת מעקב", body: "מה נשמע", fields: [] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.template.title).toBe("שיחת מעקב");
    expect((await request(app).delete("/api/activities/templates/followUp")).status).toBe(200);
  });
});

describe("an id that is no id", () => {
  it("is a 404 at once, for every persona - the check is never skipped", async () => {
    const junk = await request(app).post("/api/activities").send({ person: "not-an-id", kind: "note", title: "x" });
    expect(junk.status).toBe(404);
    expect(junk.body.code).toBe("NOT_FOUND");
    const s = await makeStudent();
    const badCycle = await request(app).post("/api/enrollments").send({ cycle: "nope", student: s._id });
    expect(badCycle.status).toBe(404);
    actAs({ kind: "manager" });
    expect((await request(app).post("/api/incidents").send({ person: "junk", at: new Date().toISOString(), reportedBy: { name: "x" }, primary: "other", description: "y" })).status).toBe(404);
    const cycle = await makeCycle();
    expect((await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: "junk" })).status).toBe(404);
  });
});
