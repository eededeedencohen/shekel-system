/**
 * @file חדר כושר פרופיט (Eden, 2026-10-29): the members, the grant, the signing page
 *
 * Most of it runs through the test bypass (a super admin); the grant test
 * signs in for real (AUTH_ENFORCE) and the lens test borrows the bypass
 * actor's kind and features (TEST_ACCOUNT).
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { ensureSeedAccounts } = require("../../../services/authService");
const { defaultPasswordFor } = require("../../../utils/password");
const { isValidIsraeliId, normalizeIsraeliId } = require("../../../utils/israeliId");
const storage = require("../../../services/storage");
const { makeStudent, makeTeacher } = require("../../helpers/factories");

const VALID_ID = "123456782";
const SIG = "data:image/png;base64," + Buffer.alloc(600, 7).toString("base64");
const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const signIn = async (username) => cookieOf(await request(app).post("/api/auth/login").send({ username, password: defaultPasswordFor(username) }));

afterEach(() => {
  TEST_ACCOUNT.kind = "super";
  delete TEST_ACCOUNT.features;
});

describe("the ID number's check digit", () => {
  test("a real number passes, a typo does not, short numbers are padded", () => {
    expect(isValidIsraeliId("123456782")).toBe(true);
    expect(isValidIsraeliId("123456789")).toBe(false);
    expect(isValidIsraeliId("000000018")).toBe(true);
    expect(isValidIsraeliId("18")).toBe(true);
    expect(normalizeIsraeliId("18")).toBe("000000018");
    expect(isValidIsraeliId("")).toBe(false);
    expect(isValidIsraeliId("1234567890")).toBe(false);
  });
});

describe("the members", () => {
  test("a new person joins: a bare student profile, the student + gym tags, the stage waits; twice is refused; leaving closes the tag; coming back revives the row", async () => {
    const made = await request(app).post("/api/gym").send({ firstName: "רון", lastName: "לוי", phone: "0501234567", gender: "male", notes: "מהוסטל ליבא" });
    expect(made.status).toBe(201);
    const m = made.body.data.membership;
    expect(m).toMatchObject({ stage: "waiting", membership: null, contract: null, personName: "רון לוי", phone: "050-1234567", notes: "מהוסטל ליבא", endedAt: null });
    expect(made.body.data.revived).toBe(false);
    expect(JSON.stringify(made.body)).not.toMatch(/inviteToken/);
    const person = (await request(app).get(`/api/people/${m.person}`)).body.data.person;
    expect(person.role).toBe("Student");
    expect(person.tags).toEqual(expect.arrayContaining(["student", "gym"]));
    expect(person.tags).not.toContain("college");
    // in the students' lists of the client: a Student role, the gym tag - and in the gym list
    expect((await request(app).get("/api/gym")).body.data.memberships.map((x) => x._id)).toEqual([m._id]);
    // the same person again
    expect((await request(app).post("/api/gym").send({ person: m.person })).status).toBe(409);
    // an existing student joins by id
    const s = await makeStudent({ firstName: "דנה", lastName: "כהן" });
    const joined = await request(app).post("/api/gym").send({ person: String(s._id) });
    expect(joined.status).toBe(201);
    expect((await request(app).get(`/api/people/${s._id}`)).body.data.person.tags).toContain("gym");
    // leaving and coming back
    expect((await request(app).delete(`/api/gym/${m._id}`)).status).toBe(204);
    const after = (await request(app).get(`/api/people/${m.person}`)).body.data.person;
    expect(after.tags).not.toContain("gym");
    expect(after.pastTags).toContain("gym");
    expect((await request(app).get(`/api/gym/${m._id}`)).body.data.membership.endedAt).toBeTruthy();
    const back = await request(app).post("/api/gym").send({ person: m.person });
    expect(back.status).toBe(201);
    expect(back.body.data.revived).toBe(true);
    expect(back.body.data.membership._id).toBe(m._id);
    expect(back.body.data.membership.endedAt).toBeNull();
    expect((await request(app).get(`/api/people/${m.person}`)).body.data.person.tags).toContain("gym");
  });

  test("the link, the signing page, the signature in the bucket, and the membership after the signing", async () => {
    const m = (await request(app).post("/api/gym").send({ firstName: "נועה", lastName: "ברק", phone: "052-9876543", gender: "female" })).body.data.membership;
    // the link lives on its own route; the list never carries the token
    const link = (await request(app).get(`/api/gym/${m._id}/link`)).body.data.link;
    expect(link.url).toMatch(/\/gym\/sign\/[0-9a-f]{32}$/);
    expect(link.live).toBe(true);
    expect(link.signed).toBe(false);
    const token = link.token;
    // the staff pressed WhatsApp
    expect((await request(app).post(`/api/gym/${m._id}/sent`)).body.data.membership.stage).toBe("sent");
    // the membership waits for the signing
    expect((await request(app).post(`/api/gym/${m._id}/membership`).send({ membership: "active" })).body.code).toBe("GYM_NOT_SIGNED");
    // the public page prefills
    const page = await request(app).get(`/api/public/gym/${token}`);
    expect(page.status).toBe(200);
    expect(page.body.data.contract).toMatchObject({ name: "נועה ברק", phone: "052-9876543", gender: "female", signed: false });
    expect((await request(app).get("/api/public/gym/nonsense")).status).toBe(404);
    // the signing: a typo in the ID number, a bad phone, no signature, then the real thing
    expect((await request(app).post(`/api/public/gym/${token}/sign`).send({ name: "נועה ברק", idNumber: "123456789", phone: "052-9876543", signature: SIG })).body.code).toBe("GYM_ID_INVALID");
    expect((await request(app).post(`/api/public/gym/${token}/sign`).send({ name: "נועה ברק", idNumber: VALID_ID, phone: "12", signature: SIG })).body.code).toBe("GYM_PHONE_INVALID");
    expect((await request(app).post(`/api/public/gym/${token}/sign`).send({ name: "נועה ברק", idNumber: VALID_ID, phone: "052-9876543" })).body.code).toBe("GYM_SIGNATURE_REQUIRED");
    const signed = await request(app).post(`/api/public/gym/${token}/sign`).send({ name: "נועה ברק", idNumber: VALID_ID, phone: "0529876543", signature: SIG });
    expect(signed.status).toBe(200);
    expect(signed.body.data.contract).toMatchObject({ signed: true, idNumber: VALID_ID, phone: "052-9876543", hasSignature: true });
    expect(storage.has(`gym/${m._id}/signature.png`)).toBe(true);
    expect((await request(app).post(`/api/public/gym/${token}/sign`).send({ name: "x", idNumber: VALID_ID, phone: "0529876543", signature: SIG })).status).toBe(409);
    // the staff see the contract and reach the signature by a redirect
    const row = (await request(app).get(`/api/gym/${m._id}`)).body.data.membership;
    expect(row.stage).toBe("signed");
    expect(row.contract).toMatchObject({ name: "נועה ברק", idNumber: VALID_ID, hasSignature: true });
    expect((await request(app).get(`/api/gym/${m._id}/signature`)).status).toBe(302);
    expect((await request(app).get(`/api/public/gym/${token}/signature`)).status).toBe(302);
    expect((await request(app).get(`/api/gym/${m._id}/link`)).body.data.link).toMatchObject({ live: false, signed: true });
    // the membership along the allowed transitions
    const set = (membership) => request(app).post(`/api/gym/${m._id}/membership`).send({ membership });
    expect((await set("finished")).body.code).toBe("GYM_TRANSITION");
    expect((await set("active")).body.data.membership.membership).toBe("active");
    expect((await set("interested")).body.code).toBe("GYM_TRANSITION");
    expect((await set("finished")).body.data.membership.membership).toBe("finished");
    expect((await set("interested")).status).toBe(200);
    // a typo in the contract, fixed by the staff
    const fixed = await request(app).patch(`/api/gym/${m._id}`).send({ contract: { name: "נועה ברק-לוי" }, notes: "עודכן" });
    expect(fixed.body.data.membership.contract.name).toBe("נועה ברק-לוי");
    expect((await request(app).patch(`/api/gym/${m._id}`).send({ contract: { idNumber: "123" } })).body.code).toBe("GYM_ID_INVALID");
    // a fresh token kills the old link
    const renewed = (await request(app).post(`/api/gym/${m._id}/link`)).body.data.link;
    expect(renewed.token).not.toBe(token);
    expect((await request(app).get(`/api/public/gym/${token}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/gym/${renewed.token}`)).status).toBe(200);
  });

  test("the search for 'הוספה לחדר הכושר' looks at every student of the system, and the grant adds one from outside the lens", async () => {
    const a = await makeStudent({ firstName: "אביגיל", lastName: "כהן-לוי" });
    await makeStudent({ firstName: "אביגיל", lastName: "פרץ" });
    expect((await request(app).post("/api/gym").send({ person: String(a._id) })).status).toBe(201);
    let found = (await request(app).get("/api/gym/people").query({ q: "אביגיל" })).body.data.people;
    expect(found.map((p) => p.lastName).sort()).toEqual(["כהן-לוי", "פרץ"]);
    expect(found.find((p) => p._id === String(a._id))).toMatchObject({ firstName: "אביגיל", inGym: true, idNumber: "", tags: expect.arrayContaining(["student", "gym"]) });
    expect(found.find((p) => p.lastName === "פרץ").inGym).toBe(false);
    // every word must be in the name
    found = (await request(app).get("/api/gym/people").query({ q: "אביגיל פר" })).body.data.people;
    expect(found.map((p) => p.lastName)).toEqual(["פרץ"]);
    // no query: everyone, by name (the window lists them all and filters as one types)
    const everyone = (await request(app).get("/api/gym/people")).body.data.people;
    expect(everyone.map((p) => p.lastName)).toEqual(expect.arrayContaining(["כהן-לוי", "פרץ"]));
    expect(everyone.length).toBeGreaterThanOrEqual(2);
    // a teacher is no student: not found, not added
    const t = await makeTeacher({ firstName: "אביגיל", lastName: "מורה" });
    expect((await request(app).get("/api/gym/people").query({ q: "אביגיל מורה" })).body.data.people).toEqual([]);
    expect((await request(app).post("/api/gym").send({ person: String(t._id) })).body.code).toBe("GYM_NOT_STUDENT");
    expect((await request(app).post("/api/gym").send({ person: "nonsense" })).status).toBe(404);
    // the hostels coordinator with the grant: a college student she does not see otherwise is found and joins
    const b = await makeStudent({ firstName: "בועז", lastName: "מכללה" });
    TEST_ACCOUNT.kind = "hostels";
    TEST_ACCOUNT.features = ["gym"];
    expect((await request(app).get("/api/people")).body.data.people.map((p) => String(p._id))).not.toContain(String(b._id));
    expect((await request(app).get("/api/gym/people").query({ q: "בועז" })).body.data.people.map((p) => p._id)).toEqual([String(b._id)]);
    expect((await request(app).post("/api/gym").send({ person: String(b._id) })).status).toBe(201);
    expect((await request(app).get("/api/people")).body.data.people.map((p) => String(p._id))).toContain(String(b._id));
    // without the grant the search is closed like the rest of the gym
    delete TEST_ACCOUNT.features;
    expect((await request(app).get("/api/gym/people").query({ q: "בועז" })).status).toBe(403);
  });

  test("erasing for good: only after leaving; the row, the signature and the gym tag's story go; a gym-made person goes with them, a student of the system stays", async () => {
    const { Person } = require("../../../models/Person");
    // a person the gym made, who signed
    const m = (await request(app).post("/api/gym").send({ firstName: "עומר", lastName: "זמני", phone: "0501112222", gender: "male" })).body.data.membership;
    const token = (await request(app).get(`/api/gym/${m._id}/link`)).body.data.link.token;
    await request(app).post(`/api/public/gym/${token}/sign`).send({ name: "עומר זמני", idNumber: VALID_ID, phone: "0501112222", signature: SIG });
    expect(storage.has(`gym/${m._id}/signature.png`)).toBe(true);
    expect((await request(app).post(`/api/gym/${m._id}/erase`)).body.code).toBe("GYM_NOT_LEFT");
    expect((await request(app).delete(`/api/gym/${m._id}`)).status).toBe(204);
    const erased = await request(app).post(`/api/gym/${m._id}/erase`);
    expect(erased.status).toBe(200);
    expect(erased.body.data).toEqual({ erased: true, personRemoved: true });
    expect((await request(app).get(`/api/gym/${m._id}`)).status).toBe(404);
    expect((await request(app).get("/api/gym")).body.data.memberships.map((x) => x._id)).not.toContain(m._id);
    expect(storage.has(`gym/${m._id}/signature.png`)).toBe(false);
    const gone = await Person.findById(m.person).lean();
    expect(gone.deletedAt).toBeTruthy();
    const tagsLeft = (await request(app).get(`/api/people/${m.person}`)).body.data.person;
    expect(tagsLeft.tags).not.toContain("gym");
    expect(tagsLeft.pastTags).not.toContain("gym");
    // a student of the system: the row goes, the person stays whole
    const s = await makeStudent({ firstName: "שירה", lastName: "נשארת" });
    const m2 = (await request(app).post("/api/gym").send({ person: String(s._id) })).body.data.membership;
    await request(app).delete(`/api/gym/${m2._id}`);
    const erased2 = await request(app).post(`/api/gym/${m2._id}/erase`);
    expect(erased2.body.data).toEqual({ erased: true, personRemoved: false });
    const stays = (await request(app).get(`/api/people/${s._id}`)).body.data.person;
    expect(stays.deletedAt).toBeFalsy();
    expect(stays.tags).not.toContain("gym");
    expect(stays.pastTags).not.toContain("gym");
    expect((await request(app).post(`/api/gym/${m2._id}/erase`)).status).toBe(404);
  });

  test("the lens: a hostels coordinator sees the gym's people only with the grant, and may give the gym tag only then", async () => {
    const m = (await request(app).post("/api/gym").send({ firstName: "גיל", lastName: "שמש" })).body.data.membership;
    // a resident of the hostels (in her lens), not yet in the gym
    const other = await makeStudent({ firstName: "לא", lastName: "בחדר" });
    expect((await request(app).post(`/api/tags/people/${other._id}`).send({ key: "hostels" })).status).toBe(200);
    TEST_ACCOUNT.kind = "hostels";
    delete TEST_ACCOUNT.features;
    expect((await request(app).get("/api/gym")).status).toBe(403);
    expect((await request(app).get("/api/gym")).body.code).toBe("FEATURE_FORBIDDEN");
    let people = (await request(app).get("/api/people")).body.data.people.map((p) => String(p._id));
    expect(people).not.toContain(m.person);
    expect((await request(app).post(`/api/tags/people/${other._id}`).send({ key: "gym" })).status).toBe(403);
    TEST_ACCOUNT.features = ["gym"];
    expect((await request(app).get("/api/gym")).status).toBe(200);
    people = (await request(app).get("/api/people")).body.data.people.map((p) => String(p._id));
    expect(people).toContain(m.person);
    expect((await request(app).get(`/api/gym/${m._id}`)).status).toBe(200);
    expect((await request(app).post(`/api/tags/people/${other._id}`).send({ key: "gym" })).status).toBe(200);
  });
});

describe("the grant on the users page", () => {
  beforeAll(() => {
    process.env.AUTH_ENFORCE = "1";
  });
  afterAll(() => {
    delete process.env.AUTH_ENFORCE;
  });

  test("the super admin switches 'gym' on for an account; the directory carries it; an unknown grant is refused", async () => {
    await ensureSeedAccounts();
    const eden = await signIn("eden");
    const tamarCookie = await signIn("tamar");
    expect((await request(app).get("/api/gym").set("Cookie", tamarCookie)).status).toBe(403);
    const accounts = (await request(app).get("/api/accounts").set("Cookie", eden)).body.data.accounts;
    const tamar = accounts.find((a) => a.username === "tamar");
    expect(tamar.features).toEqual([]);
    expect((await request(app).patch(`/api/accounts/${tamar._id}`).set("Cookie", eden).send({ features: ["flying"] })).status).toBe(400);
    const on = await request(app).patch(`/api/accounts/${tamar._id}`).set("Cookie", eden).send({ features: ["gym", "gym"] });
    expect(on.body.data.account.features).toEqual(["gym"]);
    expect((await request(app).get("/api/gym").set("Cookie", tamarCookie)).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", tamarCookie)).body.data.account.features).toEqual(["gym"]);
    expect((await request(app).get("/api/auth/staff").set("Cookie", eden)).body.data.staff.find((s) => s.name === "תמר צימרינג").features).toEqual(["gym"]);
    // viewing as her, the super admin has the grant too; viewing as someone without it, not
    expect((await request(app).get("/api/gym").set("Cookie", eden).set("X-Acting-As", tamar._id)).status).toBe(200);
    const hagai = accounts.find((a) => a.username === "hagai");
    expect((await request(app).get("/api/gym").set("Cookie", eden).set("X-Acting-As", hagai._id)).status).toBe(403);
    // the grant goes away
    const off = await request(app).patch(`/api/accounts/${tamar._id}`).set("Cookie", eden).send({ features: [] });
    expect(off.body.data.account.features).toEqual([]);
    expect((await request(app).get("/api/gym").set("Cookie", tamarCookie)).status).toBe(403);
  });
});
