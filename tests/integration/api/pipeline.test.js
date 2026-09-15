/**
 * Pipeline API — intake leads (no placeholder emails!), stage moves through
 * the one writer, and stage-filtered lists.
 */

const request = require("supertest");
const app = require("../../../app");
const { makeStudent } = require("../../helpers/factories");

describe("POST /api/people/intake", () => {
  it("creates an Interested lead in ONE document, without an email", async () => {
    const res = await request(app)
      .post("/api/people/intake")
      .send({ firstName: "דנה", lastName: "לוי", movedBy: "נעה" });
    expect(res.status).toBe(201);
    const { person } = res.body.data;
    expect(person.role).toBe("Student");
    expect(person.email).toBeUndefined();
    expect(person.pipeline.stage).toBe("Interested");
    expect(person.stageHistory).toHaveLength(1);
  });

  it("requires first and last name", async () => {
    const res = await request(app).post("/api/people/intake").send({ firstName: "רק" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_FIELDS");
  });

  it("stamps the demo world from the header", async () => {
    const res = await request(app)
      .post("/api/people/intake")
      .set("X-Dataset", "test")
      .send({ firstName: "טסט", lastName: "עולם" });
    expect(res.body.data.person.world).toBe("test");
  });
});

describe("POST /api/people/:id/stage", () => {
  it("moves the stage and appends history", async () => {
    const s = await makeStudent();
    await request(app).post(`/api/people/${s._id}/stage`).send({ stage: "Interested" });
    const res = await request(app)
      .post(`/api/people/${s._id}/stage`)
      .send({ stage: "Intake", movedBy: "ייטב", note: "שיחת היכרות" });
    expect(res.status).toBe(200);
    expect(res.body.data.person.pipeline.stage).toBe("Intake");
    expect(res.body.data.person.stageHistory).toHaveLength(2);
  });

  it("rejects an invalid stage key", async () => {
    const s = await makeStudent();
    const res = await request(app).post(`/api/people/${s._id}/stage`).send({ stage: "Nope" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STAGE");
  });
});

describe("GET /api/people?role=Student&stage=", () => {
  it("filters by pipeline stage", async () => {
    const a = await makeStudent();
    const b = await makeStudent();
    await a.moveToStage("Matching", "בדיקה");
    await b.moveToStage("Placed", "בדיקה");
    const res = await request(app).get("/api/people?role=Student&stage=Matching,NeedsReplacement");
    expect(res.body.results).toBe(1);
    expect(res.body.data.people[0]._id).toBe(String(a._id));
  });
});
