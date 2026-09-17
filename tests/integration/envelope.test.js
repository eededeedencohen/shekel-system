/**
 * Tests that the standard response envelope contract is honoured across
 * the API — including the remodel's stable error codes.
 */

const request = require("supertest");
const app = require("../../app");

describe("Response envelope", () => {
  it("collection responses follow { status, results, data: { <resource> } }", async () => {
    const res = await request(app).get("/api/people");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "success",
      results: expect.any(Number),
      data: { people: expect.any(Array) },
    });
  });

  it("404 fallback follows { status: 'fail', message }", async () => {
    const res = await request(app).get("/api/no-such-resource");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      status: "fail",
      message: expect.stringMatching(/cannot find/i),
    });
  });

  it("ValidationError surfaces as 400 fail with a message", async () => {
    const res = await request(app).post("/api/people").send({ role: "Student" });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("fail");
    expect(typeof res.body.message).toBe("string");
  });

  it("domain errors carry their stable English code", async () => {
    const res = await request(app).get("/api/lessons");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_FIELDS");
    expect(res.body.message).toMatch(/חסרים שדות חובה/);
  });

  it("GET /api/meta/domain serves every enum with Hebrew labels", async () => {
    const res = await request(app).get("/api/meta/domain");
    expect(res.status).toBe(200);
    const { domain } = res.body.data;
    // Eden's מכללה לכל pipeline (2026-09-17): five stops + the replacement side door
    expect(domain.pipelineStages.map((s) => s.key)).toEqual([
      "Interested", "Matching", "Intake", "AwaitingPlacement", "NeedsReplacement", "Placed",
    ]);
    expect(domain.intakeStages).toEqual(["Intake"]);
    expect(domain.legacyStageMap).toEqual({ ReservedSeat: "Intake", AwaitingDocuments: "Intake" });
    // the four documents + the office's approval, and the three-valued social-worker status
    expect(domain.intakeDocuments.map((d) => d.key)).toEqual(["psychiatric", "psychosocial", "socialClub", "waiver", "shkedia"]);
    expect(domain.intakeDocuments.find((d) => d.key === "shkedia").approval).toBe(true);
    expect(domain.intakeSwStatuses.map((s) => s.key)).toEqual(["new", "scheduled", "done"]);
    expect(domain.profileKinds.map((k) => k.key)).toContain("SocialWorker");
    expect(domain.enrollmentStatuses.map((s) => s.key)).toEqual([
      "reserved",
      "active",
      "completed",
      "left",
    ]);
    expect(domain.attendanceStatuses).toHaveLength(3);
    // Culture categories: grouped for the pick-list, every group real,
    // and the pre-split keys still there for stored events.
    const groups = domain.eventCategoryGroups.map((g) => g.key);
    expect(groups).toEqual(["shows", "culture", "outings", "community"]);
    const cats = domain.eventCategories;
    for (const c of cats) {
      expect(c.label).toMatch(/[֐-׿]/);
      if (c.key !== "other") expect(groups).toContain(c.group);
    }
    expect(new Set(cats.map((c) => c.key)).size).toBe(cats.length);
    const keys = cats.map((c) => c.key);
    for (const k of ["theatre", "concert", "standup", "show", "outing", "trip", "restaurant", "other"]) {
      expect(keys).toContain(k);
    }
    expect(keys[keys.length - 1]).toBe("other");
  });
});
