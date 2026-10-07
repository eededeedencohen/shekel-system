/**
 * דיווח אירוע חריג — the Ministry of Health form, mirrored on the record.
 */

const request = require("supertest");
const app = require("../../../app");
const Activity = require("../../../models/Activity");
const { makeStudent } = require("../../helpers/factories");

describe("incidents", () => {
  it("needs the time, the reporter, a classification and a description; the report is mirrored as an activity", async () => {
    const s = await makeStudent();
    const half = await request(app).post("/api/incidents").send({ person: s._id, at: "2026-10-01T10:00:00", reportedBy: { name: "אביב" }, primary: "violence" });
    expect(half.body.code).toBe("INCIDENT_INVALID");
    const badKind = await request(app).post("/api/incidents").send({ person: s._id, at: "2026-10-01T10:00:00", reportedBy: { name: "אביב" }, primary: "weather", description: "x" });
    expect(badKind.body.code).toBe("INCIDENT_INVALID");

    const made = await request(app).post("/api/incidents").send({
      person: s._id, at: "2026-10-01T10:15:00",
      reportedBy: { name: "אביב", role: "מורה" },
      primary: "violence", secondary: "אלימות מילולית",
      description: "צעק על סטודנטית ויצא מהכיתה.",
      actions: "שיחה בחוץ; חזר אחרי עשר דקות.",
      by: "אביב",
    });
    expect(made.status).toBe(201);
    const inc = made.body.data.incident;
    expect(inc.managerNotified?.name).toBeFalsy();
    expect(made.body.data.activity.kind).toBe("incident");
    expect(made.body.data.activity.title).toBe("אלימות · אלימות מילולית");
    expect(String(made.body.data.activity.related.incident)).toBe(String(inc._id));
    expect(await Activity.countDocuments({ person: s._id, kind: "incident" })).toBe(1);

    // the manager was told later → the mirror follows
    const told = await request(app).patch(`/api/incidents/${inc._id}`).send({ managerNotified: { name: "נעה" }, actions: "דווח לנעה למחרת.", by: "אביב" });
    expect(told.body.data.incident.managerNotified.name).toBe("נעה");
    expect(told.body.data.incident.managerNotified.at).toBeTruthy();
    const mirror = await Activity.findById(inc.activity);
    expect(mirror.fields.managerNotified).toMatch(/^נעה/);
    expect(mirror.fields.actions).toBe("דווח לנעה למחרת.");

    const list = await request(app).get(`/api/incidents?person=${s._id}`);
    expect(list.body.results).toBe(1);
    expect((await request(app).get("/api/incidents").set("X-Dataset", "test")).body.results).toBe(0);
  });
});
