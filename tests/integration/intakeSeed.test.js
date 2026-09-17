/**
 * The intake demo seed (scripts/lib/intakeSeed) — runs through the REAL
 * services, so it doubles as an end-to-end check of Eden's 2026-09-17
 * pipeline: every state of both boards comes out as the seed promises.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shekel-seed-"));

const Intake = require("../../models/Intake");
const Enrollment = require("../../models/Enrollment");
const { Person } = require("../../models/Person");
const { Profile } = require("../../models/profiles");
const { makeCycle, makeSubject } = require("../helpers/factories");
const { seedIntakes } = require("../../scripts/lib/intakeSeed");

const WORLD = "test";

const personNamed = (firstName) => Person.findOne({ world: WORLD, firstName });
const stageOf = async (firstName, kind) => {
  const p = await personNamed(firstName);
  return (await Profile.findOne({ person: p._id, kind })).pipeline.stage;
};
const intakeOf = async (firstName) => Intake.findOne({ world: WORLD, person: (await personNamed(firstName))._id });
const docStatus = (intake, key) => intake.documents.find((d) => d.key === key)?.status || "missing";

describe("scripts/lib/intakeSeed", () => {
  it("builds every state of the boards through the real services", async () => {
    const subject = await makeSubject({ world: WORLD, name: "ציור" });
    const seats = [];
    for (let i = 0; i < 6; i++) seats.push(await makeCycle({ world: WORLD, subject: subject._id, matching: { capacity: 3 } }));
    let n = 0;
    const findSeat = () => seats[n++ % seats.length]._id;

    const out = await seedIntakes({ world: WORLD, lastName: "טסט", findSeat, subjectIds: [String(subject._id)] });
    expect(out.byState).toEqual({ queue: 4, scheduled: 4, documents: 2, done: 3 });
    expect(await Intake.countDocuments({ world: WORLD })).toBe(13);
    expect(out.socialWorker.firstName).toBe("ייטב");

    // queue: a culture lead with one upload; a college lead parked at Intake by its seat
    const lior = await intakeOf("ליאור");
    expect(lior.status).toBe("new");
    expect(docStatus(lior, "psychiatric")).toBe("uploaded");
    expect(await stageOf("יונתן", "StudentCollege")).toBe("Intake");
    expect((await intakeOf("יונתן")).status).toBe("new");

    // scheduled: culture → Intake with a meeting; college stays at Intake
    expect(await stageOf("עמית", "StudentCulture")).toBe("Intake");
    expect((await intakeOf("עמית")).status).toBe("scheduled");
    expect(await stageOf("שירה", "StudentCollege")).toBe("Intake");

    // documents: the meeting was held, the file is still open
    const rotem = await intakeOf("רותם");
    expect(rotem.status).toBe("documents");
    expect(docStatus(rotem, "waiver")).toBe("received"); // ticked at the meeting
    expect(docStatus(rotem, "shkedia")).toBe("missing");
    const alon = await intakeOf("אלון");
    expect(alon.status).toBe("documents");
    expect(docStatus(alon, "psychiatric")).toBe("rejected");
    expect(docStatus(alon, "shkedia")).toBe("received");
    expect(await stageOf("אלון", "StudentCollege")).toBe("Intake");

    // done: culture Placed; college waiting for the start date; college placed with a future start
    expect((await intakeOf("הילה")).status).toBe("complete");
    expect(await stageOf("הילה", "StudentCulture")).toBe("Placed");
    expect(await stageOf("עידו", "StudentCollege")).toBe("AwaitingPlacement");
    const idoSeat = await Enrollment.findOne({ world: WORLD, student: (await personNamed("עידו"))._id });
    expect(idoSeat.status).toBe("reserved");
    expect(await stageOf("תמר", "StudentCollege")).toBe("Placed");
    const tamarSeat = await Enrollment.findOne({ world: WORLD, student: (await personNamed("תמר"))._id });
    expect(tamarSeat.status).toBe("active");
    expect(tamarSeat.joinedAt.getTime()).toBeGreaterThan(Date.now() + 5 * 86400000); // kept ahead of today by backdate()

    // the walk-in: a record the staff opened, meeting tomorrow, no landing token
    const gal = await intakeOf("גל");
    expect(gal.source).toBe("staff");
    expect(gal.landing?.token).toBeUndefined();
    expect(gal.status).toBe("scheduled");
  }, 60000);
});
