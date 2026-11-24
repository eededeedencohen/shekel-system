/**
 * A person's ID number (Eden, 2026-11-24: "חייבים תעודות זהות של כל
 * הסטודנטים"). It is kept on the person and shown through ONE door: the
 * social worker and the super admin read and write it; nothing else in the
 * app ever carries it - not the person, not the lists, not the audit.
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { Person } = require("../../../models/Person");
const AuditEvent = require("../../../models/AuditEvent");

afterEach(() => {
  TEST_ACCOUNT.kind = "super";
});

const VALID = "000000018"; // the check digit holds
const OTHER = "123456782";
const makePerson = async (firstName) =>
  (await request(app).post("/api/people").send({ firstName, lastName: "בדיקה", profile: { kind: "StudentCollege" } })).body.data.person._id;
const get = (id) => request(app).get(`/api/people/${id}/id-number`);
const put = (id, idNumber) => request(app).put(`/api/people/${id}/id-number`).send({ idNumber });

describe("a person's ID number", () => {
  it("is written with its check digit verified, padded to nine digits, and read back through its own door", async () => {
    const id = await makePerson("דנה");
    expect((await get(id)).body.data.idNumber).toBeNull();
    expect((await put(id, "123456789")).body.code).toBe("PERSON_ID_INVALID");
    expect((await put(id, "12ab")).body.code).toBe("PERSON_ID_INVALID");
    const saved = await put(id, "18");
    expect(saved.status).toBe(200);
    expect(saved.body.data.idNumber).toBe(VALID);
    expect((await get(id)).body.data.idNumber).toBe(VALID);
    // an empty one takes it off
    expect((await put(id, "")).body.data.idNumber).toBeNull();
    expect((await get(id)).body.data.idNumber).toBeNull();
  });

  it("is carried by nothing else: not the person, not the list, not a plain query", async () => {
    const id = await makePerson("רון");
    await put(id, VALID);
    const one = await request(app).get(`/api/people/${id}`);
    expect(JSON.stringify(one.body)).not.toContain(VALID);
    const list = await request(app).get("/api/people");
    expect(JSON.stringify(list.body)).not.toContain(VALID);
    const profiles = await request(app).get("/api/profiles?kind=StudentCollege");
    expect(JSON.stringify(profiles.body)).not.toContain(VALID);
    expect((await Person.findById(id)).idNumber).toBeUndefined();
    expect((await Person.findById(id).select("+idNumber")).idNumber).toBe(VALID);
    // the general update cannot write it either
    await request(app).put(`/api/people/${id}`).send({ firstName: "רון", idNumber: OTHER });
    expect((await get(id)).body.data.idNumber).toBe(VALID);
  });

  it("belongs to one person: a second holder is refused, and told who holds it", async () => {
    const a = await makePerson("מיה");
    const b = await makePerson("טל");
    await put(a, OTHER);
    const clash = await put(b, OTHER);
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("PERSON_ID_TAKEN");
    expect(clash.body.message).toMatch(/מיה בדיקה/);
    // the holder may save her own number again
    expect((await put(a, OTHER)).status).toBe(200);
  });

  it("is the social worker's and the super admin's alone", async () => {
    const id = await makePerson("גל");
    await put(id, VALID);
    for (const kind of ["manager", "hostels", "culture"]) {
      TEST_ACCOUNT.kind = kind;
      const read = await get(id);
      expect([403]).toContain(read.status);
      expect(JSON.stringify(read.body)).not.toContain(VALID);
      expect((await put(id, OTHER)).status).toBe(403);
    }
    TEST_ACCOUNT.kind = "social";
    expect((await get(id)).body.data.idNumber).toBe(VALID);
    expect((await put(id, OTHER)).body.data.idNumber).toBe(OTHER);
  });

  it("never enters the audit: the event says it was written, not what", async () => {
    const id = await makePerson("נוי");
    await put(id, VALID);
    // the audit is written after the answer - give it a moment
    await new Promise((r) => setTimeout(r, 300));
    const events = await AuditEvent.find({}).lean();
    expect(JSON.stringify(events)).not.toContain(VALID);
  });
});
