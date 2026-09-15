/**
 * Profiles API — the identity+profiles split over HTTP: adding roles to an
 * existing person, multi-role people, the profile-addressed pipeline, and
 * the intake find-or-create that kills duplicate humans.
 */

const request = require("supertest");
const app = require("../../../app");
const { makeStudent, makeHostel } = require("../../helpers/factories");

describe("POST /api/people/:id/profiles", () => {
  it("adds a second role to an existing person (תמר: מנהלת הוסטל + סטודנטית)", async () => {
    const s = await makeStudent();
    const hostel = await makeHostel();
    const res = await request(app)
      .post(`/api/people/${s._id}/profiles`)
      .send({ kind: "ManagerHostel", hostels: [hostel._id] });
    expect(res.status).toBe(201);
    expect(res.body.data.profile.kind).toBe("ManagerHostel");

    const list = await request(app).get(`/api/people/${s._id}/profiles`);
    expect(list.body.results).toBe(2);
    expect(list.body.data.profiles.map((p) => p.kind).sort()).toEqual([
      "ManagerHostel",
      "StudentCollege",
    ]);
  });

  it("refuses a duplicate kind with PROFILE_EXISTS", async () => {
    const s = await makeStudent();
    const res = await request(app)
      .post(`/api/people/${s._id}/profiles`)
      .send({ kind: "StudentCollege" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PROFILE_EXISTS");
  });

  it("refuses an unknown kind with INVALID_KIND", async () => {
    const s = await makeStudent();
    const res = await request(app)
      .post(`/api/people/${s._id}/profiles`)
      .send({ kind: "Wizard" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_KIND");
  });
});

describe("profile-addressed pipeline (the canonical path)", () => {
  it("POST /api/profiles/:id/stage moves the stage on THAT profile only", async () => {
    const s = await makeStudent();
    const culture = await request(app)
      .post(`/api/people/${s._id}/profiles`)
      .send({ kind: "StudentCulture" });
    const cultureId = culture.body.data.profile._id;

    await request(app).post(`/api/profiles/${cultureId}/stage`).send({ stage: "Interested" });
    const res = await request(app)
      .post(`/api/profiles/${cultureId}/stage`)
      .send({ stage: "Matching", movedBy: "בדיקה" });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.pipeline.stage).toBe("Matching");

    // the college profile is untouched — each department runs its own
    const college = await request(app).get(`/api/profiles/${s.profile._id}`);
    expect(college.body.data.profile.pipeline?.stage).toBeUndefined();
  });

  it("DELETE /api/profiles/:id deactivates the role, the person stays", async () => {
    const s = await makeStudent();
    const del = await request(app).delete(`/api/profiles/${s.profile._id}`);
    expect(del.status).toBe(204);
    const person = await request(app).get(`/api/people/${s._id}`);
    expect(person.status).toBe(200);
    expect(person.body.data.person.kinds).toEqual([]);
  });
});

describe("GET /api/profiles?kind=", () => {
  it("lists across people — e.g. all hostel managers", async () => {
    const s = await makeStudent();
    const hostel = await makeHostel();
    await request(app)
      .post(`/api/people/${s._id}/profiles`)
      .send({ kind: "ManagerHostel", hostels: [hostel._id] });
    const res = await request(app).get("/api/profiles?kind=ManagerHostel");
    expect(res.body.results).toBeGreaterThanOrEqual(1);
    expect(res.body.data.profiles.every((p) => p.kind === "ManagerHostel")).toBe(true);
    expect(res.body.data.profiles[0].person.firstName).toBeDefined();
  });
});

describe("POST /api/people/intake — find-or-create", () => {
  it("a returning lead gets a second PROFILE, never a second human", async () => {
    const first = await request(app)
      .post("/api/people/intake")
      .send({ firstName: "דנה", lastName: "לוי", phone: "052-1234567", movedBy: "נעה" });
    expect(first.status).toBe(201);
    expect(first.body.data.personExisted).toBe(false);

    const second = await request(app)
      .post("/api/people/intake")
      .send({ firstName: "דנה", lastName: "לוי", phone: "052-1234567", department: "StudentCulture" });
    expect(second.status).toBe(201);
    expect(second.body.data.personExisted).toBe(true);
    expect(second.body.data.person._id).toBe(first.body.data.person._id);
    expect(second.body.data.person.kinds.sort()).toEqual(["StudentCollege", "StudentCulture"]);
  });
});
