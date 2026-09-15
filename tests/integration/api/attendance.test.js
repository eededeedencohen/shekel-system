/**
 * Attendance API — grid upsert on (cycle, date), single-cell edits,
 * un-reporting, and the read-only archive.
 */

const request = require("supertest");
const app = require("../../../app");
const Lesson = require("../../../models/Lesson");
const { makeStudent, makeCycle, makeLesson } = require("../../helpers/factories");

describe("PUT /api/lessons/attendance", () => {
  it("creates the live lesson on first report, world stamped from the cycle", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle();
    const res = await request(app)
      .put("/api/lessons/attendance")
      .send({
        cycle: cycle._id,
        date: "2026-03-15",
        records: [{ student: s._id, status: "Present" }],
      });
    expect(res.status).toBe(200);
    const { lesson } = res.body.data;
    expect(lesson.source).toBe("live");
    expect(lesson.world).toBe("real");
    expect(lesson.date).toBe("2026-03-15T00:00:00.000Z");
    expect(lesson.attendance).toHaveLength(1);
  });

  it("re-reporting the same day REPLACES the grid on the same lesson doc", async () => {
    const [a, b] = await Promise.all([makeStudent(), makeStudent()]);
    const cycle = await makeCycle();
    const send = (records) =>
      request(app).put("/api/lessons/attendance").send({ cycle: cycle._id, date: "2026-03-15", records });
    await send([{ student: a._id, status: "Present" }]);
    const res = await send([
      { student: a._id, status: "Missing" },
      { student: b._id, status: "AnnouncedAbsence" },
    ]);
    expect(res.body.data.lesson.attendance).toHaveLength(2);
    expect(await Lesson.countDocuments({ cycle: cycle._id })).toBe(1);
  });

  it("an empty records array means 'lesson happened, nothing reported'", async () => {
    const cycle = await makeCycle();
    const res = await request(app)
      .put("/api/lessons/attendance")
      .send({ cycle: cycle._id, date: "2026-03-16", records: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.lesson.attendance).toHaveLength(0);
  });

  it("rejects a report for a cycle of another world", async () => {
    const cycle = await makeCycle(); // real
    const res = await request(app)
      .put("/api/lessons/attendance")
      .set("X-Dataset", "pokemon")
      .send({ cycle: cycle._id, date: "2026-03-15", records: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WORLD_MISMATCH");
  });
});

describe("PATCH /api/lessons/:id/attendance/:studentId", () => {
  it("upserts a single cell", async () => {
    const s = await makeStudent();
    const lesson = await makeLesson();
    const res = await request(app)
      .patch(`/api/lessons/${lesson._id}/attendance/${s._id}`)
      .send({ status: "Present", note: "הגיע בזמן" });
    expect(res.status).toBe(200);
    expect(res.body.data.lesson.attendance[0]).toMatchObject({ status: "Present", note: "הגיע בזמן" });
  });

  it("refuses archive lessons with ARCHIVE_READONLY", async () => {
    const s = await makeStudent();
    const lesson = await makeLesson({ source: "archive" });
    const res = await request(app)
      .patch(`/api/lessons/${lesson._id}/attendance/${s._id}`)
      .send({ status: "Present" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ARCHIVE_READONLY");
  });
});

describe("DELETE endpoints", () => {
  it("un-reports one student", async () => {
    const s = await makeStudent();
    const lesson = await makeLesson({ attendance: [{ student: s._id, status: "Present" }] });
    const res = await request(app).delete(`/api/lessons/${lesson._id}/attendance/${s._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.lesson.attendance).toHaveLength(0);
  });

  it("deleting an archive lesson is refused", async () => {
    const lesson = await makeLesson({ source: "archive" });
    const res = await request(app).delete(`/api/lessons/${lesson._id}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ARCHIVE_READONLY");
    expect(await Lesson.countDocuments({})).toBe(1);
  });
});

describe("GET /api/lessons", () => {
  it("requires a filter — download-everything is gone", async () => {
    const res = await request(app).get("/api/lessons");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_FIELDS");
  });

  it("per-student history is paginated, newest first", async () => {
    const s = await makeStudent();
    const cycle = await makeCycle();
    for (const d of ["2026-03-01", "2026-03-08", "2026-03-15"]) {
      await makeLesson({ cycle: cycle._id, date: d, attendance: [{ student: s._id, status: "Present" }] });
    }
    const res = await request(app).get(`/api/lessons?student=${s._id}&limit=2`);
    expect(res.body.results).toBe(2);
    expect(res.body.data.lessons[0].date > res.body.data.lessons[1].date).toBe(true);
  });

  it("hides the archive by default, shows it with ?source=all", async () => {
    const cycle = await makeCycle();
    await makeLesson({ cycle: cycle._id, date: "2026-03-01" });
    await makeLesson({ cycle: cycle._id, date: "2026-03-01", source: "archive" });
    const live = await request(app).get(`/api/lessons?cycle=${cycle._id}`);
    expect(live.body.results).toBe(1);
    const all = await request(app).get(`/api/lessons?cycle=${cycle._id}&source=all`);
    expect(all.body.results).toBe(2);
  });
});
