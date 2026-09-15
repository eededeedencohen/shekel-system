/**
 * Person + Profile — the identity/profiles split: identity stays lean, one
 * profile per (person, kind), the pipeline lives on the student profile
 * with the same sync-rule guards it had on Person.
 */

const { Person } = require("../../../models/Person");
const { Profile, MODEL_BY_KIND } = require("../../../models/profiles");
const { createProfile, createPersonWithProfile } = require("../../../services/profileService");
const { makeStudent, makeHostel } = require("../../helpers/factories");

describe("identity + profiles split", () => {
  it("a person carries no role — kinds come from the profiles collection", async () => {
    const s = await makeStudent();
    const viaBase = await Person.findById(s._id);
    expect(viaBase.role).toBeUndefined();
    expect(Person.collection.name).toBe("people");
    const profiles = await Profile.find({ person: s._id });
    expect(profiles.map((p) => p.kind)).toEqual(["StudentCollege"]);
    expect(Profile.collection.name).toBe("profiles");
  });

  it("email is optional — an intake lead needs no placeholder", async () => {
    const p = await Person.create({ firstName: "ליד" });
    expect(p.email).toBeUndefined();
  });

  it("one person can hold several kinds — but never the same kind twice", async () => {
    const s = await makeStudent();
    const hostel = await makeHostel();
    const manager = await createProfile(s, "ManagerHostel", { hostels: [hostel._id] });
    expect(manager.kind).toBe("ManagerHostel");
    await expect(createProfile(s, "StudentCollege", {})).rejects.toThrow(/כבר יש פרופיל/);
    const kinds = (await Profile.find({ person: s._id })).map((p) => p.kind).sort();
    expect(kinds).toEqual(["ManagerHostel", "StudentCollege"]);
  });

  it("profile world is copied from the person and never mismatched", async () => {
    const { person } = await createPersonWithProfile("Teacher", {
      firstName: "מורה", world: "test",
    });
    const profile = await Profile.findOne({ person: person._id });
    expect(profile.world).toBe("test");
  });

  it("every declared kind is registered as a discriminator", () => {
    for (const kind of ["StudentCollege", "StudentCulture", "Teacher", "ManagerCollege", "ManagerHostel", "Admin"]) {
      expect(MODEL_BY_KIND[kind]).toBeDefined();
    }
  });
});

describe("availability (shared TimeRange, on the person)", () => {
  it("rejects a malformed time string", async () => {
    await expect(
      makeStudent({ availability: [{ day: 1, start: "9:00", end: "10:00" }] })
    ).rejects.toThrow(/HH:mm/);
  });

  it("rejects end <= start", async () => {
    await expect(
      makeStudent({ availability: [{ day: 1, start: "10:00", end: "10:00" }] })
    ).rejects.toThrow(/אחרי שעת ההתחלה/);
  });

  it("rejects Friday (day 5)", async () => {
    await expect(
      makeStudent({ availability: [{ day: 5, start: "10:00", end: "11:00" }] })
    ).rejects.toThrow(/שישי/);
  });

  it("accepts a valid window", async () => {
    const s = await makeStudent({ availability: [{ day: 0, start: "08:00", end: "12:30" }] });
    expect(s.availability).toHaveLength(1);
  });
});

describe("pipeline sync rule (on the student profile)", () => {
  it("moveToStage writes both the history and the denormalized head", async () => {
    const s = await makeStudent();
    await s.moveToStage("Interested", "בדיקה", "התחלה");
    await s.moveToStage("Matching", "בדיקה");
    const p = s.profile;
    expect(p.pipeline.stage).toBe("Matching");
    expect(p.stageHistory).toHaveLength(2);
    expect(p.pipeline.since.getTime()).toBe(
      p.stageHistory[p.stageHistory.length - 1].movedAt.getTime()
    );
  });

  it("a save that desyncs pipeline.stage from the history tail is rejected", async () => {
    const s = await makeStudent();
    await s.moveToStage("Interested", "בדיקה");
    s.profile.pipeline = { stage: "Placed", since: new Date() }; // bypass attempt
    await expect(s.profile.save()).rejects.toThrow(/moveToStage/);
  });

  it("query updates to pipeline/stageHistory are blocked", async () => {
    const s = await makeStudent();
    await expect(
      Profile.updateOne({ _id: s.profile._id }, { $set: { "pipeline.stage": "Placed" } })
    ).rejects.toThrow(/moveToStage/);
    await expect(
      Profile.findOneAndUpdate({ _id: s.profile._id }, { stageHistory: [] })
    ).rejects.toThrow(/moveToStage/);
  });

  it("rejects an unknown stage", async () => {
    const s = await makeStudent();
    await expect(s.moveToStage("Nope")).rejects.toThrow(/שלב לא חוקי/);
  });

  it("each student kind runs its OWN pipeline", async () => {
    const s = await makeStudent();
    await s.moveToStage("Placed", "בדיקה");
    const culture = await createProfile(s, "StudentCulture", {}, {
      pipelineInit: { stage: "Interested", movedBy: "בדיקה" },
    });
    expect(culture.pipeline.stage).toBe("Interested");
    const college = await Profile.findById(s.profile._id);
    expect(college.pipeline.stage).toBe("Placed");
  });
});
