/**
 * Lesson model — the UTC-midnight path setter (covers query updates too),
 * the live-uniqueness index, archive immutability at the schema layer, and
 * the no-duplicate-student attendance validator.
 */

const Lesson = require("../../../models/Lesson");
const { makeCycle, makeLesson, makeStudent } = require("../../helpers/factories");

describe("date normalization (path setter)", () => {
  it("normalizes a datetime to UTC midnight on create", async () => {
    const lesson = await makeLesson({ date: new Date("2026-03-15T18:45:12.000Z") });
    expect(lesson.date.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("normalizes on findOneAndUpdate too — the setter closes the update-path hole", async () => {
    const lesson = await makeLesson();
    const updated = await Lesson.findOneAndUpdate(
      { _id: lesson._id },
      { $set: { date: new Date("2026-04-02T13:30:00.000Z") } },
      { new: true }
    );
    expect(updated.date.toISOString()).toBe("2026-04-02T00:00:00.000Z");
  });

  it("accepts a YYYY-MM-DD string", async () => {
    const lesson = await makeLesson({ date: "2026-05-06" });
    expect(lesson.date.toISOString()).toBe("2026-05-06T00:00:00.000Z");
  });
});

describe("one live lesson per (cycle, day)", () => {
  it("rejects a second live lesson on the same normalized day", async () => {
    const cycle = await makeCycle();
    await makeLesson({ cycle: cycle._id, date: "2026-03-15" });
    await Lesson.syncIndexes();
    await expect(
      makeLesson({ cycle: cycle._id, date: new Date("2026-03-15T20:00:00.000Z") })
    ).rejects.toThrow(/duplicate|E11000/i);
  });

  it("an archive lesson may coexist with a live one on the same day", async () => {
    const cycle = await makeCycle();
    await Lesson.syncIndexes();
    await makeLesson({ cycle: cycle._id, date: "2026-03-15" });
    const archived = await makeLesson({
      cycle: cycle._id,
      date: "2026-03-15",
      source: "archive",
    });
    expect(archived.source).toBe("archive");
  });
});

describe("attendance", () => {
  it("rejects the same student twice in one ledger", async () => {
    const s = await makeStudent();
    await expect(
      makeLesson({
        attendance: [
          { student: s._id, status: "Present" },
          { student: s._id, status: "Missing" },
        ],
      })
    ).rejects.toThrow(/פעמיים/);
  });

  it("accepts exactly the three live statuses", async () => {
    const s = await makeStudent();
    await expect(
      makeLesson({ attendance: [{ student: s._id, status: "Absent" }] })
    ).rejects.toThrow(/סטטוס נוכחות/);
    const ok = await makeLesson({
      attendance: [{ student: s._id, status: "AnnouncedAbsence" }],
    });
    expect(ok.attendance[0].isGuest).toBe(false);
  });
});

describe("archive immutability (schema layer)", () => {
  it("document save on an archive lesson is rejected", async () => {
    const lesson = await makeLesson({ source: "archive" });
    lesson.teacher = null;
    lesson.markModified("teacher");
    await expect(lesson.save()).rejects.toThrow(/ארכיוני/);
  });

  it("query updates silently exclude archive docs", async () => {
    const lesson = await makeLesson({ source: "archive" });
    const res = await Lesson.updateOne(
      { _id: lesson._id },
      { $set: { room: null } }
    );
    expect(res.matchedCount).toBe(0);
  });

  it("query deletes cannot reach archive docs", async () => {
    const lesson = await makeLesson({ source: "archive" });
    const res = await Lesson.deleteOne({ _id: lesson._id });
    expect(res.deletedCount).toBe(0);
    expect(await Lesson.countDocuments({})).toBe(1);
  });
});
