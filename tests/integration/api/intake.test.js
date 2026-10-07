/**
 * קליטה (אינטייק) - the public sign-up page and the social worker's flow,
 * with the social worker's corrections of 2026-10-07.
 *
 * Eden's pipeline (2026-09-17) end to end: landing → Interested (per
 * program) → schedule → Intake → done → entered in שקדיה + the required
 * documents in force → complete; תרבות לכל lands on Placed, מכללה לכל waits
 * at AwaitingPlacement with its held seat until the managers enter the
 * start date (→ Placed). A reserved seat is what parks a college lead at
 * Intake. Documents carry validity (the psychiatric report its own date,
 * the waiver a year from its signature), files live in the database, the
 * links expire.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// Legacy disk files would go to a temp dir, never into server/uploads.
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shekel-intake-"));

const request = require("supertest");
const app = require("../../../app");
const Intake = require("../../../models/Intake");
const UploadLink = require("../../../models/UploadLink");
const StoredFile = require("../../../models/StoredFile");
const Activity = require("../../../models/Activity");
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
const dayStr = (daysFromNow) => new Date(Date.now() + daysFromNow * 86400000).toISOString().slice(0, 10);
const NEXT_YEAR = dayStr(365);

/** Staff tick - the dated report always carries its expiry. */
const tick = (intakeId, key, body = {}) =>
  request(app)
    .patch(`/api/intakes/${intakeId}/documents/${key}`)
    .send({ status: "received", by: "ייטב", ...(key === "psychiatric" && { validUntil: NEXT_YEAR }), ...body });
/** The coordinator entered the person in שקדיה. */
const enterShkedia = (intakeId, body = {}) =>
  request(app).patch(`/api/intakes/${intakeId}/shkedia`).send({ enteredAt: dayStr(0), by: "נעה", decisionNo: "12345", ...body });
/** The whole file: the three required documents + שקדיה. */
const fillFile = async (intakeId) => {
  for (const key of ["psychiatric", "psychosocial", "waiver"]) await tick(intakeId, key);
  return enterShkedia(intakeId);
};

describe("GET /api/public/join/options", () => {
  it("serves the pick-lists the page renders from", async () => {
    await makeSubject({ name: "ציור" });
    const res = await request(app).get("/api/public/join/options");
    expect(res.status).toBe(200);
    const o = res.body.data.options;
    expect(o.programs.map((p) => p.key)).toEqual(["StudentCollege", "StudentCulture"]);
    expect(o.subjects.map((s) => s.name)).toContain("ציור");
    // the documents of the file - the social club letter is optional; שקדיה is not a document any more
    expect(o.documents.map((d) => d.key)).toEqual(["psychiatric", "psychosocial", "waiver", "socialClub"]);
    expect(o.documents.find((d) => d.key === "socialClub").optional).toBe(true);
    expect(o.documents.find((d) => d.key === "psychiatric").validity).toBe("dated");
    expect(o.documents.find((d) => d.key === "waiver").validity).toBe("signed");
    expect(o.residences.length).toBeGreaterThan(3);
  });
});

describe("POST /api/public/join", () => {
  it("creates the person, one Interested profile per program, and the intake record with a link that expires in a day", async () => {
    const res = await submit({ programs: ["StudentCulture", "StudentCollege"], email: "Dana@Example.com", preferences: { categories: ["standup", "movie", "nope"], days: [0, 2] } });
    expect(res.status).toBe(201);
    const { token, view, programs } = res.body.data;
    expect(token).toMatch(/^[\w-]{20,}$/);
    expect(programs).toEqual([{ kind: "StudentCulture", created: true }, { kind: "StudentCollege", created: true }]);
    expect(view.documents.map((d) => d.status)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(view.link.temporary).toBe(false);
    expect(new Date(view.link.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600000);

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
  it("uploads a file INTO THE DATABASE, replaces it, and refuses junk", async () => {
    const { token } = (await submit({})).body.data;
    const up = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "psychiatric", fileName: "psy.png", mime: "image/png", data: PNG_1PX });
    expect(up.status).toBe(200);
    const row = up.body.data.view.documents.find((d) => d.key === "psychiatric");
    expect(row.status).toBe("uploaded");
    expect(row.fileName).toBe("psy.png");
    expect(row.pending).toBe(true); // a dated document waits for the staff's date
    let intake = await Intake.findOne({});
    const first = intake.documents.find((d) => d.key === "psychiatric").file;
    expect(first.stored).toBeTruthy();
    expect(first.storedName).toBeUndefined();
    expect(await StoredFile.countDocuments()).toBe(1);
    expect(fs.readdirSync(process.env.UPLOAD_DIR)).toEqual([]); // nothing on the disk any more

    // replace → the old bytes are gone from the files table
    await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "psychiatric", fileName: "psy2.png", mime: "image/png", data: PNG_1PX });
    expect(await StoredFile.countDocuments()).toBe(1);
    intake = await Intake.findOne({});
    expect(String(intake.documents.find((d) => d.key === "psychiatric").file.stored)).not.toBe(String(first.stored));

    const bad = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "psychiatric", fileName: "x.exe", mime: "application/x-msdownload", data: PNG_1PX });
    expect(bad.body.code).toBe("DOCUMENT_INVALID");
    // an unknown type with a known extension is fine (Windows sends "" for HEIC / Word)
    const byExt = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "psychosocial", fileName: "דוח.docx", mime: "", data: PNG_1PX });
    expect(byExt.status).toBe(200);
    expect((await Intake.findOne({})).documents.find((d) => d.key === "psychosocial").file.mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const heic = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "socialClub", fileName: "IMG_0001.HEIC", mime: "application/octet-stream", data: PNG_1PX });
    expect(heic.status).toBe(200);
    // a real photo (well over the old 100kb JSON default) goes through
    const big = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "waiver", fileName: "photo.jpg", mime: "image/jpeg", data: Buffer.alloc(3 * 1024 * 1024, 7).toString("base64") });
    expect(big.status).toBe(200);
    // over the limit → a clean 413, not "Something went wrong"
    const huge = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "waiver", fileName: "photo.jpg", mime: "image/jpeg", data: Buffer.alloc(13 * 1024 * 1024, 7).toString("base64") });
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe("PAYLOAD_TOO_LARGE");
    // שקדיה is not a document any more - nothing to upload under that key
    const unknown = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "shkedia", fileName: "w.png", mime: "image/png", data: PNG_1PX });
    expect(unknown.body.code).toBe("DOCUMENT_UNKNOWN");
    expect((await request(app).get("/api/public/join/not-a-real-token-at-all")).status).toBe(404);
  });

  it("cannot replace a document the staff already confirmed", async () => {
    const { token } = (await submit({})).body.data;
    const intake = await Intake.findOne({});
    await tick(intake._id, "psychiatric");
    const res = await request(app)
      .post(`/api/public/join/${token}/documents`)
      .send({ key: "psychiatric", fileName: "psy.png", mime: "image/png", data: PNG_1PX });
    expect(res.body.code).toBe("DOCUMENT_LOCKED");
  });

  it("locks a day after the submission (410) - a re-submission renews it", async () => {
    const { token } = (await submit({})).body.data;
    await Intake.updateOne({}, { $set: { "landing.linkExpiresAt": new Date(Date.now() - 1000) } });
    const expired = await request(app).get(`/api/public/join/${token}`);
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe("INTAKE_LINK_EXPIRED");
    expect((await request(app).post(`/api/public/join/${token}/documents`).send({ key: "psychosocial", fileName: "a.png", mime: "image/png", data: PNG_1PX })).status).toBe(410);
    await submit({}); // the same person again → the link lives again
    expect((await request(app).get(`/api/public/join/${token}`)).status).toBe(200);
  });

  it("drops rows of a retired checklist on save and keeps the four documents", async () => {
    const { intakeId } = (await submit({})).body.data;
    await Intake.collection.updateOne({ _id: new (require("mongoose").Types.ObjectId)(intakeId) }, { $push: { documents: { key: "shkedia", status: "received" } } });
    const res = await tick(intakeId, "psychiatric");
    expect(res.status).toBe(200);
    const keys = (await Intake.findById(intakeId)).documents.map((d) => d.key).sort();
    expect(keys).toEqual(["psychiatric", "psychosocial", "socialClub", "waiver"]);
  });
});

describe("temporary upload links", () => {
  it("the coordinator makes a link for the minutes she picks; it opens the requested documents only, and locks when its time is over", async () => {
    const { intakeId } = (await submit({})).body.data;
    const bad = await request(app).post(`/api/intakes/${intakeId}/links`).send({ minutes: 45, by: "נעה" });
    expect(bad.body.code).toBe("LINK_MINUTES_INVALID");
    const made = await request(app).post(`/api/intakes/${intakeId}/links`).send({ minutes: 30, docs: ["psychiatric"], by: "נעה", token: "client-made-token-abcdef12" });
    expect(made.status).toBe(201);
    const link = made.body.data.link;
    expect(link.token).toBe("client-made-token-abcdef12"); // the client may name the token - the page knows the link at once
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 60000);
    expect(made.body.data.intake.log.at(-1).action).toBe("link");

    const view = await request(app).get(`/api/public/join/${link.token}`);
    expect(view.status).toBe(200);
    expect(view.body.data.view.link.temporary).toBe(true);
    expect(view.body.data.view.documents.map((d) => d.key)).toEqual(["psychiatric"]);
    // another document is not this link's business
    expect((await request(app).post(`/api/public/join/${link.token}/documents`).send({ key: "psychosocial", fileName: "a.png", mime: "image/png", data: PNG_1PX })).body.code).toBe("DOCUMENT_UNKNOWN");
    const up = await request(app).post(`/api/public/join/${link.token}/documents`).send({ key: "psychiatric", fileName: "psy.png", mime: "image/png", data: PNG_1PX });
    expect(up.status).toBe(200);
    expect((await UploadLink.findOne({ token: link.token })).usedAt).toHaveLength(1);

    await UploadLink.updateOne({ token: link.token }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const gone = await request(app).get(`/api/public/join/${link.token}`);
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe("INTAKE_LINK_EXPIRED");
    const list = await request(app).get(`/api/intakes/${intakeId}/links`);
    expect(list.body.results).toBe(1);
  });
});

describe("the social worker's flow", () => {
  it("schedule → Intake, done keeps the file open, שקדיה + the documents → Placed (תרבות לכל)", async () => {
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

    // "בוצע אינטייק" with the template's fields → the intake activity on the record
    const done = await request(app).post(`/api/intakes/${intakeId}/done`).send({
      by: "ייטב", summary: "שיחה טובה",
      fields: { background: "עצמאית", expectations: "חברים", goals: "קביעות", treating: "מרפאה" },
    });
    expect(done.status).toBe(200);
    expect(done.body.data.intake.status).toBe("documents");
    expect(done.body.data.intake.log.at(-1).note).toMatch(/עוד חסר: קליטה בשקדיה/);
    expect(done.body.data.activity.kind).toBe("intake");
    expect(done.body.data.activity.fields.goals).toBe("קביעות");
    expect(await Activity.countDocuments({ person: personId, kind: "intake" })).toBe(1);
    expect(await stageOf(personId, "StudentCulture")).toBe("Intake"); // one stage - the tags carry the sub-state

    for (const key of ["psychiatric", "psychosocial"]) await tick(intakeId, key);
    await request(app).patch(`/api/intakes/${intakeId}/documents/waiver`).send({ status: "waived", by: "ייטב", note: "נחתם ידנית" });
    // every required document in, שקדיה still missing → still open
    expect((await Intake.findById(intakeId)).status).toBe("documents");
    const last = await enterShkedia(intakeId);
    expect(last.body.data.intake.status).toBe("complete");
    expect(last.body.data.intake.shkedia.decisionNo).toBe("12345");
    expect(last.body.data.intake.completedAt).toBeTruthy();
    expect(await stageOf(personId, "StudentCulture")).toBe("Placed");
    expect((await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב" })).body.code).toBe("INTAKE_ALREADY_DONE");
  });

  it("everything in up front → done goes straight to complete → Placed", async () => {
    const { token, intakeId } = (await submit({})).body.data;
    for (const key of ["psychiatric", "psychosocial", "waiver"]) {
      await request(app).post(`/api/public/join/${token}/documents`).send({ key, fileName: `${key}.png`, mime: "image/png", data: PNG_1PX });
    }
    // the dated / signed documents count only once the staff confirmed them with their dates
    await tick(intakeId, "psychiatric");
    await tick(intakeId, "waiver", { signedAt: dayStr(-3) });
    await enterShkedia(intakeId);
    const intake = await Intake.findById(intakeId);
    const waiver = intake.documents.find((d) => d.key === "waiver");
    expect(waiver.signedAt).toBeTruthy();
    expect(new Date(waiver.validUntil).getFullYear()).toBe(new Date(waiver.signedAt).getFullYear() + 1);
    await request(app).post("/api/intakes/schedule").send({ person: intake.person, at: "2026-09-15T10:00:00", by: "ייטב" });
    const done = await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב" });
    expect(done.body.data.intake.status).toBe("complete");
    expect(await stageOf(intake.person, "StudentCulture")).toBe("Placed");
  });

  it("the waiver ticked at the meeting counts as signed there, good for a year; a student's own upload completes the rest", async () => {
    const { token, intakeId } = (await submit({})).body.data;
    const intake = await Intake.findById(intakeId);
    await request(app).post("/api/intakes/schedule").send({ person: intake.person, at: "2026-09-15T10:00:00", by: "ייטב" });
    const done = await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true, at: "2026-09-15T10:00:00" });
    const waiver = done.body.data.intake.documents.find((d) => d.key === "waiver");
    expect(waiver.status).toBe("received");
    expect(waiver.validUntil.slice(0, 10)).toBe("2027-09-15");
    await tick(intakeId, "psychiatric");
    await enterShkedia(intakeId);
    expect(await stageOf(intake.person, "StudentCulture")).toBe("Intake");
    const up = await request(app).post(`/api/public/join/${token}/documents`).send({ key: "psychosocial", fileName: "ps.png", mime: "image/png", data: PNG_1PX });
    expect(up.body.data.view.complete).toBe(true);
    expect(await stageOf(intake.person, "StudentCulture")).toBe("Placed");
  });

  it("מכללה לכל: a reserved seat parks the lead at Intake; a complete file → AwaitingPlacement; the start date → Placed", async () => {
    const { intakeId } = (await submit({ programs: ["StudentCollege"] })).body.data;
    const intake = await Intake.findById(intakeId);
    const personId = intake.person;
    const cycle = await makeCycle();
    const held = await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: personId, status: "reserved", createdBy: "נעה" });
    expect(held.status).toBe(201);
    expect(await stageOf(personId, "StudentCollege")).toBe("Intake");

    // the meeting is ייטב's business - the college stage does not move for it
    const sched = await request(app).post("/api/intakes/schedule").send({ person: personId, at: "2026-09-15T10:00:00", by: "ייטב" });
    expect(sched.body.data.moved).toEqual([]);
    expect(await stageOf(personId, "StudentCollege")).toBe("Intake");
    await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true });
    const last = await fillFile(intakeId);
    expect(last.body.data.intake.status).toBe("complete");
    expect(last.body.data.moved).toEqual([{ kind: "StudentCollege", stage: "AwaitingPlacement" }]);
    expect(await stageOf(personId, "StudentCollege")).toBe("AwaitingPlacement");
    let e = await Enrollment.findOne({ student: personId });
    expect(e.status).toBe("reserved"); // the seat waits for the start date

    // נעה enters the start date → משובץ
    const start = await request(app)
      .patch(`/api/enrollments/${e._id}`)
      .send({ status: "active", joinedAt: "2026-10-04T00:00:00", movedBy: "נעה", note: "עודכנו המסגרת והסטודנט" });
    expect(start.status).toBe(200);
    expect(await stageOf(personId, "StudentCollege")).toBe("Placed");
    e = await Enrollment.findOne({ student: personId });
    expect(e.status).toBe("active");
    const d = new Date(e.joinedAt); // sent as local midnight - compare in local time
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 10, 4]);
    const prof = await Profile.findOne({ person: personId, kind: "StudentCollege" });
    expect(prof.stageHistory.at(-1).note).toMatch(/מתחיל\/ה/);
  });

  it("מכללה לכל without a seat: the file completes while the lead waits; the seat then goes straight to AwaitingPlacement", async () => {
    const { intakeId } = (await submit({ programs: ["StudentCollege"] })).body.data;
    const intake = await Intake.findById(intakeId);
    const personId = intake.person;
    await request(app).post("/api/intakes/schedule").send({ person: personId, at: "2026-09-15T10:00:00", by: "ייטב" });
    await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב" });
    const last = await fillFile(intakeId);
    expect(last.body.data.intake.status).toBe("complete");
    expect(last.body.data.moved).toEqual([]);
    expect(await stageOf(personId, "StudentCollege")).toBe("Interested"); // still the managers' call
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: personId, status: "reserved" });
    expect(await stageOf(personId, "StudentCollege")).toBe("AwaitingPlacement");
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: personId }); // fulfil the reservation
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
    await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב" });
    await fillFile(intakeId);
    expect(await stageOf(personId, "StudentCulture")).toBe("Placed");
    expect(await stageOf(personId, "StudentCollege")).toBe("AwaitingPlacement");
    expect(await Intake.countDocuments()).toBe(1);
  });

  it("דוח פסיכיאטרי needs the date written in it; an expired one keeps the file open; a new date renews it", async () => {
    const { token, intakeId } = (await submit({})).body.data;
    const noDate = await request(app).patch(`/api/intakes/${intakeId}/documents/psychiatric`).send({ status: "received", by: "ייטב" });
    expect(noDate.body.code).toBe("DOCUMENT_DATE_REQUIRED");
    const badDate = await request(app).patch(`/api/intakes/${intakeId}/documents/psychiatric`).send({ status: "received", by: "ייטב", validUntil: "soon" });
    expect(badDate.body.code).toBe("INVALID_DATE");

    // everything else in; an EXPIRED report does not complete the file
    const intake = await Intake.findById(intakeId);
    await request(app).post("/api/intakes/schedule").send({ person: intake.person, at: "2026-09-15T10:00:00", by: "ייטב" });
    await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true });
    await tick(intakeId, "psychosocial");
    await enterShkedia(intakeId);
    const expired = await tick(intakeId, "psychiatric", { validUntil: "2025-01-01" });
    expect(expired.body.data.intake.documents.find((d) => d.key === "psychiatric").status).toBe("received");
    expect(expired.body.data.intake.status).toBe("documents");
    expect(expired.body.data.intake.log.at(-1).note).toMatch(/בתוקף עד 1\.1\.2025/);
    // the student sees the expiry on the personal link
    const view = (await request(app).get(`/api/public/join/${token}`)).body.data.view;
    expect(view.documents.find((d) => d.key === "psychiatric").expired).toBe(true);
    // renewed with a future date → complete
    const renewed = await tick(intakeId, "psychiatric");
    expect(renewed.body.data.intake.status).toBe("complete");
    expect(await stageOf(intake.person, "StudentCulture")).toBe("Placed");
    // a staff upload of the report without a date only stores the file
    const up = await request(app)
      .post(`/api/intakes/${intakeId}/documents`)
      .send({ key: "psychiatric", fileName: "psy.png", mime: "image/png", data: PNG_1PX, by: "ייטב" });
    expect(up.body.data.intake.documents.find((d) => d.key === "psychiatric").status).toBe("uploaded");
    // a completed file STAYS complete - an expiry later is an alert, not a reopened file
    expect(up.body.data.intake.status).toBe("complete");
  });

  it("שקדיה is the coordinator's own action: a date is required; clearing it reopens an unfinished file", async () => {
    const { intakeId } = (await submit({})).body.data;
    expect((await request(app).patch(`/api/intakes/${intakeId}/shkedia`).send({ by: "נעה" })).body.code).toBe("SHKEDIA_DATE_REQUIRED");
    expect((await request(app).patch(`/api/intakes/${intakeId}/shkedia`).send({ by: "נעה", enteredAt: "nope" })).body.code).toBe("INVALID_DATE");
    const intake = await Intake.findById(intakeId);
    await request(app).post("/api/intakes/schedule").send({ person: intake.person, at: "2026-09-15T10:00:00", by: "ייטב" });
    await request(app).post(`/api/intakes/${intakeId}/done`).send({ by: "ייטב", waiverSigned: true });
    for (const key of ["psychiatric", "psychosocial"]) await tick(intakeId, key);
    expect((await Intake.findById(intakeId)).status).toBe("documents");
    const entered = await enterShkedia(intakeId, { decisionNo: "77" });
    // the שקדיה entry, then the completion it caused
    expect(entered.body.data.intake.log.at(-2).note).toMatch(/נקלט\/ה בשקדיה .* החלטה 77/);
    expect(entered.body.data.intake.log.at(-1).action).toBe("completed");
    expect(entered.body.data.intake.status).toBe("complete");
    // a mistake, taken back - but the file was completed, so it stays complete (the student is already placed)
    const cleared = await request(app).patch(`/api/intakes/${intakeId}/shkedia`).send({ clear: true, by: "נעה" });
    expect(cleared.body.data.intake.shkedia?.enteredAt).toBeFalsy();
    expect(cleared.body.data.intake.status).toBe("complete");
  });

  it("the staff's reply on a document reaches the student; a delete removes the file from the database", async () => {
    const { token, intakeId } = (await submit({})).body.data;
    await request(app).post(`/api/public/join/${token}/documents`).send({ key: "psychosocial", fileName: "ps.png", mime: "image/png", data: PNG_1PX });
    const reply = await request(app)
      .patch(`/api/intakes/${intakeId}/documents/psychosocial`)
      .send({ status: "comment", by: "ייטב", note: "חסר העמוד השני - אפשר לצלם שוב?" });
    expect(reply.status).toBe(200);
    const row = reply.body.data.intake.documents.find((d) => d.key === "psychosocial");
    expect(row.status).toBe("uploaded"); // the status stays
    expect(row.note).toBe("חסר העמוד השני - אפשר לצלם שוב?");
    expect(reply.body.data.intake.log.at(-1)).toMatchObject({ action: "docNote" });
    const view = (await request(app).get(`/api/public/join/${token}`)).body.data.view;
    expect(view.documents.find((d) => d.key === "psychosocial").note).toBe("חסר העמוד השני - אפשר לצלם שוב?");

    expect(await StoredFile.countDocuments()).toBe(1);
    const gone = await request(app).patch(`/api/intakes/${intakeId}/documents/psychosocial`).send({ status: "missing", by: "ייטב" });
    expect(gone.body.data.intake.documents.find((d) => d.key === "psychosocial").status).toBe("missing");
    expect(await StoredFile.countDocuments()).toBe(0);
    expect(gone.body.data.intake.log.at(-1).note).toMatch(/הקובץ נמחק/);
  });

  it("a walk-in (no landing page): staff open the record and schedule by person id", async () => {
    const s = await makeStudent();
    await s.moveToStage("Interested", "בדיקה");
    const res = await request(app).post("/api/intakes/schedule").send({ person: s._id, at: "2026-09-20T09:00:00", by: "ייטב" });
    expect(res.status).toBe(200);
    expect(res.body.data.intake.source).toBe("staff");
    expect(res.body.data.intake.landing.token).toBeUndefined();
    expect(await stageOf(s._id, "StudentCollege")).toBe("Interested"); // a college lead enters Intake through a seat
    const list = await request(app).get("/api/intakes?status=scheduled");
    expect(list.body.results).toBe(1);
    expect(list.body.data.intakes[0].person.firstName).toBe("סטודנט");
  });

  it("serves a stored file to staff (from the database) and lists the record by person", async () => {
    const { token, intakeId } = (await submit({})).body.data;
    await request(app).post(`/api/public/join/${token}/documents`).send({ key: "psychosocial", fileName: "ps.png", mime: "image/png", data: PNG_1PX });
    const file = await request(app).get(`/api/intakes/${intakeId}/documents/psychosocial/file`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/image\/png/);
    expect(file.body.length).toBe(Buffer.from(PNG_1PX, "base64").length);
    expect((await request(app).get(`/api/intakes/${intakeId}/documents/psychiatric/file`)).status).toBe(404);
    const intake = await Intake.findById(intakeId);
    const byPerson = await request(app).get(`/api/intakes/person/${intake.person}`);
    expect(byPerson.status).toBe(200);
    expect(byPerson.body.data.intake.landing.token).toBe(token);
  });

  it("her stages 1 and 3: the first call's facts (+ a שיחה ראשונית activity), the coordinator, the committee date", async () => {
    const s = await makeStudent();
    await s.moveToStage("Interested", "בדיקה");
    const screened = await request(app).post("/api/intakes/screening").send({
      person: s._id, eligibility: "yes", interests: ["college", "socialClub", "nope"], by: "נעה", note: "שיחה טובה, רוצה בוקר",
    });
    expect(screened.status).toBe(200);
    expect(screened.body.data.intake.screening.eligibility).toBe("yes");
    expect(screened.body.data.intake.screening.interests).toEqual(["college", "socialClub"]);
    expect(screened.body.data.activity.kind).toBe("firstCall");
    expect(screened.body.data.activity.fields.interests).toBe("מכללה לכל, מועדון חברתי");
    expect(screened.body.data.intake.log.at(-1).note).toMatch(/שיחה ראשונית · זכאי\/ת לסל שיקום · מכללה לכל, מועדון חברתי/);
    const id = screened.body.data.intake._id;
    expect((await request(app).patch(`/api/intakes/${id}/screening`).send({ eligibility: "maybe", by: "נעה" })).body.code).toBe("INVALID_STATUS");

    const coord = await request(app).patch(`/api/intakes/${id}/coordinator`).send({ name: "נעה", by: "חגי" });
    expect(coord.body.data.intake.coordinator.name).toBe("נעה");
    expect(coord.body.data.intake.log.at(-1).note).toBe("רכזת מטפלת: נעה");
    const noCoord = await request(app).patch(`/api/intakes/${id}/coordinator`).send({ name: "", by: "חגי" });
    expect(noCoord.body.data.intake.coordinator?.name).toBeFalsy();

    const committee = await request(app).patch(`/api/intakes/${id}/committee`).send({ committeeDate: "2025-03-01", by: "נעה" });
    expect(committee.body.data.intake.committeeDate.slice(0, 10)).toBe("2025-03-01");
    expect((await request(app).patch(`/api/intakes/${id}/committee`).send({ committeeDate: "x", by: "נעה" })).body.code).toBe("INVALID_DATE");
  });
});
