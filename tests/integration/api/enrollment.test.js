/**
 * Enrollment API — the single membership write path: capacity enforcement,
 * the unique no-double-enroll invariant, reservation fulfillment as a
 * status flip, world isolation, and the pipeline auto-advance side-effect.
 */

const request = require("supertest");
const app = require("../../../app");
const Enrollment = require("../../../models/Enrollment");
const { makeStudent, makeCycle } = require("../../helpers/factories");

describe("POST /api/enrollments", () => {
  it("enrolls a student (201) and stamps world from the cycle", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle();
    const res = await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: s._id });
    expect(res.status).toBe(201);
    expect(res.body.data.enrollment).toMatchObject({ status: "active", world: "real" });
  });

  it("blocks double-enrollment with 409 DUPLICATE_ENROLLMENT", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: s._id });
    const res = await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: s._id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_ENROLLMENT");
  });

  it("enforces capacity with 409 CYCLE_FULL (reserved seats count)", async () => {
    const cycle = await makeCycle({ matching: { capacity: 2 } });
    const [a, b, c] = await Promise.all([makeStudent(), makeStudent(), makeStudent()]);
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: a._id });
    await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: b._id, status: "reserved" });
    const res = await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: c._id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CYCLE_FULL");
  });

  it("fulfilling a reservation flips the SAME document (no new record)", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle({ matching: { capacity: 1 } });
    await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: s._id, status: "reserved" });
    const res = await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: s._id }); // activate — full cycle, but the seat is theirs
    expect(res.status).toBe(201);
    expect(res.body.data.enrollment.status).toBe("active");
    expect(await Enrollment.countDocuments({ cycle: cycle._id })).toBe(1);
  });

  it("a seat for a lead the social worker has not met parks them at ReservedSeat", async () => {
    const s = await makeStudent();
    await s.moveToStage("Matching", "בדיקה");
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: s._id });
    const after = await request(app).get(`/api/people/${s._id}`);
    expect(after.body.data.person.pipeline.stage).toBe("ReservedSeat");
    const hist = after.body.data.person.stageHistory;
    expect(hist[hist.length - 1]).toMatchObject({ stage: "ReservedSeat" });
  });

  it("auto-advances a student waiting AFTER intake straight to Placed", async () => {
    const s = await makeStudent();
    await s.moveToStage("AwaitingPlacement", "בדיקה");
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: s._id });
    const after = await request(app).get(`/api/people/${s._id}`);
    expect(after.body.data.person.pipeline.stage).toBe("Placed");
  });

  it("rejects cross-world enrollment with WORLD_MISMATCH", async () => {
    const s = await makeStudent({ world: "test" });
    const cycle = await makeCycle(); // real world
    const res = await request(app)
      .post("/api/enrollments")
      .set("X-Dataset", "test")
      .send({ cycle: cycle._id, student: s._id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WORLD_MISMATCH");
  });

  it("validates slotId against the cycle schedule", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle();
    const res = await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: s._id, slotId: s._id }); // not a slot
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SLOT_NOT_FOUND");
  });
});

describe("PATCH /api/enrollments/:id", () => {
  it("marks a student as left with leftAt", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle();
    const created = await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: s._id });
    const res = await request(app)
      .patch(`/api/enrollments/${created.body.data.enrollment._id}`)
      .send({ status: "left" });
    expect(res.status).toBe(200);
    expect(res.body.data.enrollment.status).toBe("left");
    expect(res.body.data.enrollment.leftAt).toBeTruthy();
  });

  it("frees the seat when a student leaves", async () => {
    const cycle = await makeCycle({ matching: { capacity: 1 } });
    const [a, b] = await Promise.all([makeStudent(), makeStudent()]);
    const created = await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: a._id });
    await request(app)
      .patch(`/api/enrollments/${created.body.data.enrollment._id}`)
      .send({ status: "left" });
    const res = await request(app)
      .post("/api/enrollments")
      .send({ cycle: cycle._id, student: b._id });
    expect(res.status).toBe(201);
  });
});

describe("GET /api/enrollments", () => {
  it("filters by cycle and by student, world-scoped", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: s._id });
    const byCycle = await request(app).get(`/api/enrollments?cycle=${cycle._id}`);
    expect(byCycle.body.results).toBe(1);
    const byStudent = await request(app).get(`/api/enrollments?student=${s._id}`);
    expect(byStudent.body.results).toBe(1);
    const otherWorld = await request(app)
      .get(`/api/enrollments?cycle=${cycle._id}`)
      .set("X-Dataset", "test");
    expect(otherWorld.body.results).toBe(0);
  });
});
