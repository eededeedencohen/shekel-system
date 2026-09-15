/**
 * קליטה (אינטייק) — the public sign-up page and the social worker's flow.
 *
 * Eden's diagram end to end: landing → Interested (per program) →
 * schedule → Intake → done + waiver → Placed / AwaitingDocuments →
 * documents → Placed; plus the מכללה side: a held seat parks a lead at
 * ReservedSeat, completion activates it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// Files go to a temp dir, never into server/uploads.
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shekel-intake-"));

const request = require("supertest");
const app = require("../../../app");
const Intake = require("../../../models/Intake");
const Enrollment = require("../../../models/Enrollment");
const { Profile } = require("../../../models/profiles");
const { makeStudent, makeCycle, makeSubject } = require("../../helpers/factories");

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const submit = (body, world) => {
  const r = request(app).post("/api/public/join");
  if (world) r.set("X-Dataset", world);
  return r.send({
    firstName: "דנה",
    lastName: "לוי",
    phone: "0521234567",
    programs: ["StudentCulture"],
    ...body,
  });
};

const stageOf = async (personId, kind) => (await Profile.findOne({ person: personId, kind })).pipeline.stage;

describe("GET /api/public/join/options", () => {
  it("serves the pick-lists the page renders from", async () => {
    await makeSubject({ name: "ציור" });
    const res = await request(app).get("/api/public/join/options");
    expect(res.status).toBe(200);
    const o = res.body.data.options;
    expect(o.programs.map((p) => p.key)).toEqual(["StudentCollege", "StudentCulture"]);
    expect(o.subjects.map((s) => s.name)).toContain("ציור");
    expect(o.documents.every((d) => d.upload)).toBe(true);
    expect(o.documents.map((d) => d.key)).not.toContain("waiver");
    expect(o.residences.length).toBeGreaterThan(3);
  });
});

describe("POST /api/public/join", () => {
  it("creates the person, one Interested profile per program, and the intake record with a link", async () => {
    const res = await submit({ programs: ["StudentCulture", "StudentCollege"], email: "Dana@Example.com", preferences: { categories: ["standup", "movie", "nope"], days: [0, 2] } });
    expect(res.status).toBe(201);
    const { token, view, programs } = res.body.data;
    expect(token).toMatch(/^[\w-]{20,}$/);
    expect(programs).toEqual([{ kind: "StudentCulture", created: true }, { kind: "StudentCollege", created: true }]);
    expect(view.documents.map((d) => d.status)).toEqual(["missing", "missing", "missing", "missing", "missing"]);

    const people = await request(app).get("/api/people?kind=StudentCulture");
    expect(people.body.results).toBe(1);
    const person = people.body.data.people[0];
    expect(person.phone).toBe("052-1234567");
    expect(person.email).toBe("dana@example.com");
    expect(person.programs.map((p) => [p.kind, p.stage])).toEqual(
      expect.arrayContaining([["StudentCulture", "Interested"], ["StudentCollege", "Interested"]])
    );
    expect(person.preferredCategories).toEqual(["standup", "movie"]);
    const intake = await Intake.findOne({ person: person._id });
    expect(intake.status).toBe("new");
    expect(intake.source).toBe("landing");
    expect(intake.landing.preferences.days).toEqual([0, 2]);
    expect(intake.log[0].action).toBe("submitted");
  });

  it("never duplicates a human: a second submission by the same phone adds the other program only", async () => {
    await submit({ programs: ["StudentCulture"] });
    const res = await submit({ programs: ["StudentCollege", "StudentCulture"], phone: "052-123-4567" });
    expect(res.status).toBe(201);
    expect(res.body.data.personExisted).toBe(true);
    expect(res.body.data.programs).toEqual(
      expect.arrayContaining([{ kind: "StudentCollege", created: true }, { kind: "StudentCulture", existed: true }])
    );
    expect(await Intake.countDocuments()).toBe(1);
    const people = await request(app).get("/api/people?kind=StudentCulture,StudentCollege");
    expect(people.body.results).toBe(1);
  });

  it("validates: names, phone, at least one program, honeypot", async () => {
    expect((await submit({ firstName: "" })).body.code).toBe("MISSING_FIELDS");
    expect((await submit({ phone: "12" })).body.code).toBe("INVALID_PHONE");
    expect((await submit({ programs: [] })).body.code).toBe("NO_PROGRAM");
    expect((await submit({ website: "http://spam" })).body.code).toBe("SPAM_REJECTED");
  });

  it("stamps the demo world from the header and keeps subjects world-scoped", async () => {
    const real = await makeSubject({ name: "מוסיקה" });
    const res = await submit({ programs: ["StudentCollege"], preferences: { subjects: [String(real._id)] } }, "test");
    expect(res.status).toBe(201);
    const intake = await Intake.findOne({});
    expect(intake.world).toBe("test");
    expect(intake.landing.preferences.subjects).toHaveLength(0); // a real-world subject is not visible from test
  });
});

describe("the personal documents link", () => {
  it("uploads a file, replaces it, and refuses junk", async () => {
    const { token } = (await submit({})).body.data;
    const up = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "idCopy", fileName: "id.png", mime: "image/png", data: PNG_1PX });
    expect(up.status).toBe(200);
    const row = up.body.data.view.documents.find((d) => d.key === "idCopy");
    expect(row.status).toBe("uploaded");
    expect(row.fileName).toBe("id.png");
    const intake = await Intake.findOne({});
    const stored = intake.documents.find((d) => d.key === "idCopy").file.storedName;
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR, "real", String(intake._id), stored))).toBe(true);

    // replace → the old file is gone
    await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "idCopy", fileName: "id2.png", mime: "image/png", data: PNG_1PX });
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR, "real", String(intake._id), stored))).toBe(false);

    const bad = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "idCopy", fileName: "x.exe", mime: "application/x-msdownload", data: PNG_1PX });
    expect(bad.body.code).toBe("DOCUMENT_INVALID");
    const unknown = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "waiver", fileName: "w.png", mime: "image/png", data: PNG_1PX });
    expect(unknown.body.code).toBe("DOCUMENT_UNKNOWN");
    expect((await request(app).get("/api/public/join/not-a-real-token-at-all")).status).toBe(404);
  });

  it("cannot replace a document the staff already confirmed", async () => {
    const { token } = (await submit({})).body.data;
    const intake = await Intake.findOne({});
    await request(app).patch(`/api/intakes/${intake._id}/documents/idCopy`).send({ status: "received", by: "ייטב" });
    const res = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "idCopy", fileName: "id.png", mime: "image/png", data: PNG_1PX });
    expect(res.body.code).toBe("DOCUMENT_LOCKED");
  });
});

describe("the social worker's flow", () => {
  it("schedule → Intake, done with missing docs → AwaitingDocuments, last doc → Placed (תרבות לכל)", async () => {
    const { intakeId } = (await submit({})).body.data;
    const intake = await Intake.findById(intakeId);
    const personId = intake.person;

    const sched = await request(app)
      .post("/api/intakes/schedule")
      .send({ person: personId, at: "2026-09-15T10:00:00", by: "ייטב", note: "במשרד" });
    expect(sched.status).toBe(200);
    expect(sched.body.data.intake.status).toBe("scheduled");
    expect(sched.body.data.moved).toEqual(["StudentCulture"]);
    expect(await stageOf(personId, "StudentCulture")).toBe("Intake");

    const noWaiver = await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: false });
    expect(noWaiver.body.code).toBe("WAIVER_REQUIRED");

    const done = await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true, summary: "שיחה טובה" });
    expect(done.status).toBe(200);
    expect(done.body.data.intake.status).toBe("documents");
    expect(await stageOf(personId, "StudentCulture")).toBe("AwaitingDocuments");
    const prof = await Profile.findOne({ person: personId, kind: "StudentCulture" });
    expect(prof.stageHistory.at(-1).note).toMatch(/חסרים/);

    for (const key of ["idCopy", "eligibility", "medical"]) {
      await request(app).patch(`/api/intakes/${intakeId}/documents/${key}`).send({ status: "received", by: "ייטב" });
    }
    expect((await Intake.findById(intakeId)).status).toBe("documents");
    const last = await request(app).patch(`/api/intakes/${intakeId}/documents/registrationForm`).send({ status: "waived", by: "ייטב", note: "נחתם ידנית" });
    expect(last.body.data.intake.status).toBe("complete");
    expect(last.body.data.intake.completedAt).toBeTruthy();
    expect(await stageOf(personId, "StudentCulture")).toBe("Placed");
    // guardianship is optional — never blocked completion
    expect((await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true })).body.code).toBe("INTAKE_ALREADY_DONE");
  });

  it("all documents uploaded up front → done goes straight to Placed", async () => {
    const { token, intakeId } = (await submit({})).body.data;
    for (const key of ["idCopy", "eligibility", "medical", "registrationForm"]) {
      await request(app).post(`/api/public/join/${token}/documents`).send({ key, fileName: `${key}.png`, mime: "image/png", data: PNG_1PX });
    }
    const intake = await Intake.findById(intakeId);
    await request(app).post("/api/intakes/schedule").send({ person: intake.person, at: "2026-09-15T10:00:00", by: "ייטב" });
    const done = await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true });
    expect(done.body.data.intake.status).toBe("complete");
    expect(await stageOf(intake.person, "StudentCulture")).toBe("Placed");
  });

  it("a student's own upload after the meeting completes the intake too", async () => {
    const { token, intakeId } = (await submit({})).body.data;
    const intake = await Intake.findById(intakeId);
    await request(app).post("/api/intakes/schedule").send({ person: intake.person, at: "2026-09-15T10:00:00", by: "ייטב" });
    await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true });
    for (const key of ["idCopy", "eligibility", "medical"]) {
      await request(app).patch(`/api/intakes/${intakeId}/documents/${key}`).send({ status: "received", by: "ייטב" });
    }
    expect(await stageOf(intake.person, "StudentCulture")).toBe("AwaitingDocuments");
    const up = await request(app).post(`/api/public/join/${token}/documents`).send({ key: "registrationForm", fileName: "f.png", mime: "image/png", data: PNG_1PX });
    expect(up.body.data.view.complete).toBe(true);
    expect(await stageOf(intake.person, "StudentCulture")).toBe("Placed");
  });

  it("מכללה לכל: a held seat parks the lead at ReservedSeat; completion activates it → Placed", async () => {
    const { intakeId } = (await submit({ programs: ["StudentCollege"] })).body.data;
    const intake = await Intake.findById(intakeId);
    const personId = intake.person;
    const cycle = await makeCycle();
    const held = await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: personId, status: "reserved", createdBy: "נעה" });
    expect(held.status).toBe(201);
    expect(await stageOf(personId, "StudentCollege")).toBe("ReservedSeat");

    await request(app).post("/api/intakes/schedule").send({ person: personId, at: "2026-09-15T10:00:00", by: "ייטב" });
    expect(await stageOf(personId, "StudentCollege")).toBe("Intake");
    await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true });
    for (const key of ["idCopy", "eligibility", "medical", "registrationForm"]) {
      await request(app).patch(`/api/intakes/${intakeId}/documents/${key}`).send({ status: "received", by: "ייטב" });
    }
    expect(await stageOf(personId, "StudentCollege")).toBe("Placed");
    const e = await Enrollment.findOne({ student: personId });
    expect(e.status).toBe("active");
    expect(e.joinedAt).toBeTruthy();
  });

  it("מכללה לכל without a seat: completion → AwaitingPlacement, then a seat → Placed", async () => {
    const { intakeId } = (await submit({ programs: ["StudentCollege"] })).body.data;
    const intake = await Intake.findById(intakeId);
    const personId = intake.person;
    await request(app).post("/api/intakes/schedule").send({ person: personId, at: "2026-09-15T10:00:00", by: "ייטב" });
    await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true });
    for (const key of ["idCopy", "eligibility", "medical", "registrationForm"]) {
      await request(app).patch(`/api/intakes/${intakeId}/documents/${key}`).send({ status: "received", by: "ייטב" });
    }
    expect(await stageOf(personId, "StudentCollege")).toBe("AwaitingPlacement");
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: personId });
    expect(await stageOf(personId, "StudentCollege")).toBe("Placed");
  });

  it("a person in BOTH programs is met once: one record moves both profiles", async () => {
    const { intakeId } = (await submit({ programs: ["StudentCulture", "StudentCollege"] })).body.data;
    const intake = await Intake.findById(intakeId);
    const personId = intake.person;
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: personId, status: "reserved" });
    await request(app).post("/api/intakes/schedule").send({ person: personId, at: "2026-09-15T10:00:00", by: "ייטב" });
    expect(await stageOf(personId, "StudentCulture")).toBe("Intake");
    expect(await stageOf(personId, "StudentCollege")).toBe("Intake");
    await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true });
    for (const key of ["idCopy", "eligibility", "medical", "registrationForm"]) {
      await request(app).patch(`/api/intakes/${intakeId}/documents/${key}`).send({ status: "received", by: "ייטב" });
    }
    expect(await stageOf(personId, "StudentCulture")).toBe("Placed");
    expect(await stageOf(personId, "StudentCollege")).toBe("Placed");
    expect(await Intake.countDocuments()).toBe(1);
  });

  it("a walk-in (no landing page): staff open the record and schedule by person id", async () => {
    const s = await makeStudent();
    await s.moveToStage("Interested", "בדיקה");
    const res = await request(app).post("/api/intakes/schedule").send({ person: s._id, at: "2026-09-20T09:00:00", by: "ייטב" });
    expect(res.status).toBe(200);
    expect(res.body.data.intake.source).toBe("staff");
    expect(res.body.data.intake.landing.token).toBeUndefined();
    expect(await stageOf(s._id, "StudentCollege")).toBe("Intake");
    const list = await request(app).get("/api/intakes?status=scheduled");
    expect(list.body.results).toBe(1);
    expect(list.body.data.intakes[0].person.firstName).toBe("סטודנט");
  });

  it("serves a stored file to staff and lists the record by person", async () => {
    const { token, intakeId } = (await submit({})).body.data;
    await request(app).post(`/api/public/join/${token}/documents`).send({ key: "medical", fileName: "med.png", mime: "image/png", data: PNG_1PX });
    const file = await request(app).get(`/api/intakes/${intakeId}/documents/medical/file`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/image\/png/);
    expect((await request(app).get(`/api/intakes/${intakeId}/documents/idCopy/file`)).status).toBe(404);
    const intake = await Intake.findById(intakeId);
    const byPerson = await request(app).get(`/api/intakes/person/${intake.person}`);
    expect(byPerson.status).toBe(200);
    expect(byPerson.body.data.intake.landing.token).toBe(token);
  });
});
