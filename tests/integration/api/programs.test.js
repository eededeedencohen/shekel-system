/**
 * Programs API — a student's memberships in מכללה לכל / תרבות לכל:
 * both at once (rare), transfers between them (rarer) with the whole story
 * logged on the profiles, and the unwinding of the program being left.
 */

const request = require("supertest");
const app = require("../../../app");
const Enrollment = require("../../../models/Enrollment");
const EventRegistration = require("../../../models/EventRegistration");
const { Profile } = require("../../../models/profiles");
const {
  makeStudent, makeCycle, makeCultureStaff, makeCultureStudent, makeEvent,
} = require("../../helpers/factories");

describe("profile lifecycle log", () => {
  it("a new profile opens with an `opened` entry and `since`", async () => {
    const s = await makeStudent();
    const profile = await Profile.findById(s.profile._id);
    expect(profile.since).toBeInstanceOf(Date);
    expect(profile.log).toHaveLength(1);
    expect(profile.log[0].event).toBe("opened");
  });

  it("POST /api/people/:id/profiles logs who opened the role", async () => {
    const s = await makeStudent();
    const res = await request(app)
      .post(`/api/people/${s._id}/profiles`)
      .send({ kind: "StudentCulture", by: "רותם", note: "נרשמה גם לתרבות" });
    expect(res.status).toBe(201);
    expect(res.body.data.profile.log[0]).toMatchObject({ event: "opened", by: "רותם", note: "נרשמה גם לתרבות" });
    expect(res.body.data.profile.pipeline.stage).toBe("Interested");
  });
});

describe("both programs at once", () => {
  it("GET /api/people lists both kinds and a programs[] row per program", async () => {
    const s = await makeStudent();
    await request(app).post(`/api/people/${s._id}/profiles`).send({ kind: "StudentCulture" });
    const res = await request(app).get(`/api/people/${s._id}`);
    expect(res.body.data.person.kinds.sort()).toEqual(["StudentCollege", "StudentCulture"]);
    expect(res.body.data.person.programs.map((p) => p.kind).sort()).toEqual(["StudentCollege", "StudentCulture"]);
    expect(res.body.data.person.programs.every((p) => p.active)).toBe(true);
  });
});

describe("POST /api/people/:id/transfer", () => {
  it("college → culture: closes the college profile, opens culture, leaves cycle seats", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: s._id });

    const res = await request(app)
      .post(`/api/people/${s._id}/transfer`)
      .send({ from: "StudentCollege", to: "StudentCulture", by: "נעה", note: "העדיפה את הטיולים" });
    expect(res.status).toBe(200);
    const person = res.body.data.person;
    expect(person.kinds).toEqual(["StudentCulture"]);
    expect(person.pastKinds).toEqual(["StudentCollege"]);
    expect(res.body.data.effects.enrollmentsLeft).toBe(1);

    // the story is on both profiles
    const college = await Profile.findOne({ person: s._id, kind: "StudentCollege" });
    const culture = await Profile.findOne({ person: s._id, kind: "StudentCulture" });
    expect(college.active).toBe(false);
    expect(college.until).toBeInstanceOf(Date);
    expect(college.log.map((l) => l.event)).toEqual(["opened", "transferredOut"]);
    expect(college.log[1]).toMatchObject({ by: "נעה", otherKind: "StudentCulture", note: "העדיפה את הטיולים" });
    expect(culture.active).toBe(true);
    expect(culture.log[0]).toMatchObject({ event: "transferredIn", otherKind: "StudentCollege" });
    expect(culture.pipeline.stage).toBe("Interested");
    expect(culture.stageHistory[0].note).toContain("מכללה לכל");

    // the seat was given back, with the reason on the record
    const e = await Enrollment.findOne({ student: s._id });
    expect(e.status).toBe("left");
    expect(e.leftAt).toBeInstanceOf(Date);
    expect(e.note).toContain("תרבות לכל");
  });

  it("culture → college: cancels FUTURE event seats (and promotes the waitlist), keeps past ones", async () => {
    const staff = await makeCultureStaff();
    const mover = await makeCultureStudent();
    const waiting = await makeCultureStudent();
    const future = await makeEvent({ by: staff._id, settings: { capacity: 1 } });
    const past = await makeEvent({ by: staff._id, date: new Date(Date.now() - 3 * 86400000) });

    await request(app).post("/api/event-registrations").send({ event: future._id, student: mover._id, by: staff._id });
    const w = await request(app).post("/api/event-registrations").send({ event: future._id, student: waiting._id, by: staff._id });
    expect(w.body.data.registration.status).toBe("waitlisted");
    // a past registration, built as history
    const culture = require("../../../services/cultureService");
    await culture.register({ eventId: past._id, studentId: mover._id, world: "real", by: staff._id, trusted: true });

    const res = await request(app)
      .post(`/api/people/${mover._id}/transfer`)
      .send({ from: "StudentCulture", to: "StudentCollege", by: "רותם", stage: "Matching" });
    expect(res.status).toBe(200);
    expect(res.body.data.effects).toMatchObject({ registrationsCancelled: 1, promoted: 1 });

    const regs = await EventRegistration.find({ student: mover._id }).populate("event", "date");
    const fut = regs.find((r) => String(r.event._id) === String(future._id));
    const pst = regs.find((r) => String(r.event._id) === String(past._id));
    expect(fut.status).toBe("cancelled");
    expect(fut.history.at(-1).reason).toContain("מכללה לכל");
    expect(pst.status).toBe("registered"); // history stays
    const promoted = await EventRegistration.findOne({ student: waiting._id });
    expect(promoted.status).toBe("registered");
    expect(promoted.history.at(-1).action).toBe("promoted");

    // the new college profile starts where we said
    const college = await Profile.findOne({ person: mover._id, kind: "StudentCollege" });
    expect(college.pipeline.stage).toBe("Matching");
  });

  it("refuses same-program, non-student and already-active targets", async () => {
    const s = await makeStudent();
    let res = await request(app).post(`/api/people/${s._id}/transfer`).send({ from: "StudentCollege", to: "StudentCollege" });
    expect(res.body.code).toBe("INVALID_TRANSFER");
    res = await request(app).post(`/api/people/${s._id}/transfer`).send({ from: "StudentCollege", to: "Teacher" });
    expect(res.body.code).toBe("INVALID_TRANSFER");
    await request(app).post(`/api/people/${s._id}/profiles`).send({ kind: "StudentCulture" });
    res = await request(app).post(`/api/people/${s._id}/transfer`).send({ from: "StudentCollege", to: "StudentCulture" });
    expect(res.body.code).toBe("INVALID_TRANSFER");
  });

  it("transferring back REOPENS the old profile (no duplicate) and keeps the full log", async () => {
    const s = await makeStudent();
    await request(app).post(`/api/people/${s._id}/transfer`).send({ from: "StudentCollege", to: "StudentCulture", by: "נעה" });
    const back = await request(app)
      .post(`/api/people/${s._id}/transfer`)
      .send({ from: "StudentCulture", to: "StudentCollege", by: "חגי", note: "התחרט" });
    expect(back.status).toBe(200);
    expect(await Profile.countDocuments({ person: s._id })).toBe(2);
    const college = await Profile.findOne({ person: s._id, kind: "StudentCollege" });
    expect(college.active).toBe(true);
    expect(college.until).toBeNull();
    expect(college.log.map((l) => l.event)).toEqual(["opened", "transferredOut", "transferredIn"]);
    expect(college.stageHistory.at(-1).stage).toBe("Interested");

    const timeline = await request(app).get(`/api/people/${s._id}/programs`);
    expect(timeline.body.data.entries.map((e) => e.event)).toEqual([
      "opened", "transferredOut", "transferredIn", "transferredOut", "transferredIn",
    ]);
  });

  it("a culture-only student cannot take a cycle seat", async () => {
    const s = await makeCultureStudent();
    const cycle = await makeCycle();
    const res = await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: s._id });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NO_STUDENT_PROFILE");
  });
});

describe("close / reopen with a reason", () => {
  it("POST /api/profiles/:id/close logs `closed` and unwinds seats; reopen logs `reopened`", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: s._id });

    const close = await request(app)
      .post(`/api/profiles/${s.profile._id}/close`)
      .send({ by: "ייטב", note: "עבר דירה לצפון" });
    expect(close.status).toBe(200);
    expect(close.body.data.person.kinds).toEqual([]);
    expect(close.body.data.effects.enrollmentsLeft).toBe(1);

    const again = await request(app).post(`/api/profiles/${s.profile._id}/close`).send({});
    expect(again.body.code).toBe("PROFILE_INACTIVE");

    const reopen = await request(app)
      .post(`/api/profiles/${s.profile._id}/reopen`)
      .send({ by: "ייטב", note: "חזר", stage: "Matching" });
    expect(reopen.status).toBe(200);
    expect(reopen.body.data.person.kinds).toEqual(["StudentCollege"]);
    const profile = await Profile.findById(s.profile._id);
    expect(profile.log.map((l) => l.event)).toEqual(["opened", "closed", "reopened"]);
    expect(profile.pipeline.stage).toBe("Matching");
  });

  it("DELETE /api/profiles/:id still works and is logged as `closed`", async () => {
    const s = await makeStudent();
    const del = await request(app).delete(`/api/profiles/${s.profile._id}?by=נעה&note=ביטול`);
    expect(del.status).toBe(204);
    const profile = await Profile.findById(s.profile._id);
    expect(profile.active).toBe(false);
    expect(profile.log.at(-1)).toMatchObject({ event: "closed", by: "נעה", note: "ביטול" });
  });
});
