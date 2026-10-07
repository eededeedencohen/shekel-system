/**
 * לשונית פעילויות - a person's record with editable templates, and the
 * leave report (דיווח עזיבה) that closes a program and writes to it.
 */

const request = require("supertest");
const app = require("../../../app");
const Activity = require("../../../models/Activity");
const ActivityTemplate = require("../../../models/ActivityTemplate");
const Enrollment = require("../../../models/Enrollment");
const { Profile } = require("../../../models/profiles");
const { makeStudent, makeCycle } = require("../../helpers/factories");

describe("activity templates", () => {
  it("every kind has a default; a world stores its own version and can go back", async () => {
    const all = await request(app).get("/api/activities/templates");
    expect(all.status).toBe(200);
    expect(all.body.results).toBe(9);
    const followUp = all.body.data.templates.find((t) => t.kind === "followUp");
    expect(followUp.stored).toBe(false);
    expect(followUp.fields.map((f) => f.key)).toEqual(["attendance", "motivation", "impression", "next"]);

    const saved = await request(app).put("/api/activities/templates/followUp").send({
      title: "שיחת מעקב רבעונית",
      body: "מה שלומך?",
      fields: [
        { key: "attendance", label: "נוכחות", type: "select", options: ["סדירה", "חלקית"], required: true },
        { key: "callFamily", label: "לעדכן את המשפחה", type: "checkbox" },
      ],
      by: "נעה",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.template.stored).toBe(true);
    expect(saved.body.data.template.fields).toHaveLength(2);
    expect(await ActivityTemplate.countDocuments()).toBe(1);
    // the test world still sees the default
    const other = await request(app).get("/api/activities/templates/followUp").set("X-Dataset", "test");
    expect(other.body.data.template.stored).toBe(false);

    const reset = await request(app).delete("/api/activities/templates/followUp");
    expect(reset.body.data.template.stored).toBe(false);
    expect(await ActivityTemplate.countDocuments()).toBe(0);
  });

  it("refuses a broken template and an unknown kind", async () => {
    expect((await request(app).put("/api/activities/templates/followUp").send({ fields: [{ key: "a", label: "א", type: "select", options: [] }] })).body.code).toBe("TEMPLATE_INVALID");
    expect((await request(app).put("/api/activities/templates/followUp").send({ fields: [{ key: "a", label: "א" }, { key: "a", label: "ב" }] })).body.code).toBe("TEMPLATE_INVALID");
    expect((await request(app).put("/api/activities/templates/nope").send({})).body.code).toBe("ACTIVITY_KIND_UNKNOWN");
    expect((await request(app).get("/api/activities/templates/nope")).body.code).toBe("ACTIVITY_KIND_UNKNOWN");
  });
});

describe("activities", () => {
  it("writes a follow-up from the template, checks its fields, lists, edits and deletes", async () => {
    const s = await makeStudent();
    const missing = await request(app).post("/api/activities").send({ person: s._id, kind: "followUp", by: "נעה", body: "קצר" });
    expect(missing.body.code).toBe("ACTIVITY_FIELD_REQUIRED");
    const badOption = await request(app).post("/api/activities").send({ person: s._id, kind: "followUp", by: "נעה", fields: { attendance: "לפעמים", impression: "טוב" } });
    expect(badOption.body.code).toBe("ACTIVITY_FIELD_REQUIRED");

    const ok = await request(app).post("/api/activities").send({
      person: s._id, kind: "followUp", by: "נעה", at: "2026-10-01T10:00:00", body: "שיחה טובה",
      fields: { attendance: "סדירה", motivation: "גבוהה", impression: "מרוצה", next: "", extra: "ignored?" },
    });
    expect(ok.status).toBe(201);
    const a = ok.body.data.activity;
    expect(a.title).toBe("שיחת מעקב");
    expect(a.fields.attendance).toBe("סדירה");
    expect(a.fields.next).toBeUndefined();
    expect(a.fields.extra).toBe("ignored?"); // a key the template does not know is kept as typed

    await request(app).post("/api/activities").send({ person: s._id, kind: "update", by: "נעה", body: "טלפון קצר" });
    const list = await request(app).get(`/api/activities?person=${s._id}`);
    expect(list.body.results).toBe(2);
    expect(list.body.data.activities[0].kind).toBe("update"); // newest first

    const edited = await request(app).patch(`/api/activities/${a._id}`).send({ body: "שיחה ארוכה", fields: { attendance: "חלקית" }, by: "חגי" });
    expect(edited.body.data.activity.body).toBe("שיחה ארוכה");
    expect(edited.body.data.activity.fields.attendance).toBe("חלקית");
    expect(edited.body.data.activity.editedBy).toBe("חגי");

    expect((await request(app).delete(`/api/activities/${a._id}`)).status).toBe(204);
    expect(await Activity.countDocuments()).toBe(1);
    expect((await request(app).delete(`/api/activities/${a._id}`)).status).toBe(404);
  });

  it("refuses an unknown kind, a bad date, and a person of another world", async () => {
    const s = await makeStudent();
    expect((await request(app).post("/api/activities").send({ person: s._id, kind: "nope", by: "נעה" })).body.code).toBe("ACTIVITY_KIND_UNKNOWN");
    expect((await request(app).post("/api/activities").send({ person: s._id, kind: "update", by: "נעה", at: "yesterday" })).body.code).toBe("INVALID_DATE");
    expect((await request(app).post("/api/activities").set("X-Dataset", "test").send({ person: s._id, kind: "update", by: "נעה" })).body.code).toBe("WORLD_MISMATCH");
  });
});

describe("דיווח עזיבה", () => {
  it("closes the program with the official date and reason, gives the seats back, and writes the leave activity", async () => {
    const s = await makeStudent();
    await s.moveToStage("Placed", "נעה");
    const cycle = await makeCycle();
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: s._id });
    const profile = await Profile.findOne({ person: s._id, kind: "StudentCollege" });

    expect((await request(app).post(`/api/profiles/${profile._id}/leave`).send({ reason: "vanished", by: "נעה" })).body.code).toBe("LEAVE_REASON_INVALID");
    const left = await request(app).post(`/api/profiles/${profile._id}/leave`).send({
      reason: "moved", leftAt: "2026-09-30", note: "עבר לדיור בחיפה", shkediaReported: true, by: "נעה",
    });
    expect(left.status).toBe(200);
    expect(left.body.data.person.programs.find((p) => p.kind === "StudentCollege").active).toBe(false);
    expect(left.body.data.effects.enrollmentsLeft).toBe(1);
    expect(left.body.data.activity.kind).toBe("leave");
    expect(left.body.data.activity.fields).toMatchObject({ reason: "moved", reasonLabel: "עבר/ה למסגרת אחרת", shkediaReported: true });
    expect(left.body.data.activity.program).toBe("StudentCollege");
    expect((await Enrollment.findOne({ student: s._id })).status).toBe("left");
    const closed = await Profile.findById(profile._id);
    expect(closed.active).toBe(false);
    expect(closed.log.at(-1).note).toBe("עבר/ה למסגרת אחרת · עבר לדיור בחיפה");
    // a second report on a closed program is refused
    expect((await request(app).post(`/api/profiles/${profile._id}/leave`).send({ reason: "moved", by: "נעה" })).body.code).toBe("PROFILE_INACTIVE");
  });
});
