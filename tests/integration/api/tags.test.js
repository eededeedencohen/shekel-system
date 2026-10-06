/**
 * תגיות — the catalog, the migration from the old profiles (additive,
 * idempotent, hostels students kept out of מכללה לכל), the tags every
 * person and cycle answer carries, and the writers (give / take / reopen).
 */

const request = require("supertest");
const app = require("../../../app");
const { Tag, TagGroup } = require("../../../models/Tag");
const { PersonTag, PersonTagEvent } = require("../../../models/PersonTag");
const CycleTag = require("../../../models/CycleTag");
const tags = require("../../../services/tagService");
const { migrateWorld } = require("../../../services/tagMigration");
const { makeStudent, makeTeacher, makeCycle, makeEnrollment, makeHostel, makeCultureStudent } = require("../../helpers/factories");

describe("the catalog", () => {
  it("is written once per world and served", async () => {
    await tags.ensureCatalog("real");
    await tags.ensureCatalog("real");
    expect(await TagGroup.countDocuments({ world: "real" })).toBe(2);
    expect(await Tag.countDocuments({ world: "real" })).toBe(10);
    const res = await request(app).get("/api/tags");
    expect(res.status).toBe(200);
    expect(res.body.data.groups.map((g) => g.key)).toEqual(["role", "program"]);
    expect(res.body.data.tags.find((t) => t.key === "hostels")).toMatchObject({ label: "הוסטלים", group: "program", active: true });
    // another world has its own copy
    expect((await request(app).get("/api/tags").set("X-Dataset", "test")).body.data.tags).toHaveLength(10);
    expect(await Tag.countDocuments()).toBe(20);
  });
});

describe("the migration", () => {
  it("turns profiles into tags: a college student, a teacher, a hostels-only student, a hostel cycle", async () => {
    const hostel = await makeHostel();
    const college = await makeStudent();
    const teacher = await makeTeacher();
    const hostelOnly = await makeStudent();
    const both = await makeStudent();
    const collegeCycle = await makeCycle({ teacher: teacher._id });
    const hostelCycle = await makeCycle({ teacher: teacher._id, hostel: hostel._id });
    await makeEnrollment({ cycle: collegeCycle._id, student: college._id });
    await makeEnrollment({ cycle: hostelCycle._id, student: hostelOnly._id });
    await makeEnrollment({ cycle: hostelCycle._id, student: both._id });
    await makeEnrollment({ cycle: collegeCycle._id, student: both._id });

    const stats = await migrateWorld("real");
    expect(stats.hostelOnly).toBe(1);

    const people = (await request(app).get("/api/people")).body.data.people;
    const of = (p) => people.find((x) => x._id === String(p._id));
    expect(of(college).tags.sort()).toEqual(["college", "student"]);
    expect(of(teacher).tags).toEqual(["teacher"]);
    expect(of(hostelOnly).tags.sort()).toEqual(["hostels", "student"]);
    expect(of(both).tags.sort()).toEqual(["college", "hostels", "student"]);

    const cycles = (await request(app).get("/api/cycles")).body.data.cycles;
    expect(cycles.find((c) => c._id === String(collegeCycle._id))).toMatchObject({ program: "college", tags: ["college"] });
    expect(cycles.find((c) => c._id === String(hostelCycle._id))).toMatchObject({ program: "hostels", tags: ["hostels"] });
    expect(await PersonTagEvent.countDocuments({ event: "opened" })).toBeGreaterThanOrEqual(4);

    // run it again: nothing doubles
    const rows = await PersonTag.countDocuments();
    const events = await PersonTagEvent.countDocuments();
    const again = await migrateWorld("real");
    expect(again.inserted).toBe(0);
    expect(await PersonTag.countDocuments()).toBe(rows);
    expect(await PersonTagEvent.countDocuments()).toBe(events);
    expect(await CycleTag.countDocuments()).toBe(2);
  });

  it("copies a closed profile as a closed tag with its story", async () => {
    const culture = await makeCultureStudent();
    const closed = await makeStudent();
    closed.profile.active = false;
    closed.profile.until = new Date("2026-05-01");
    closed.profile.log.push({ event: "closed", at: new Date("2026-05-01"), by: "נעה", note: "עזב" });
    await closed.profile.save();
    await migrateWorld("real");
    const people = (await request(app).get("/api/people")).body.data.people;
    const c = people.find((x) => x._id === String(closed._id));
    expect(c.tags).toEqual([]);
    expect(c.pastTags.sort()).toEqual(["college", "student"]);
    expect(people.find((x) => x._id === String(culture._id)).tags.sort()).toEqual(["culture", "student"]);
    const row = await PersonTag.findOne({ person: closed._id, tag: (await tags.tagMap("real")).get("college")._id });
    expect(row.until).toEqual(new Date("2026-05-01"));
    expect((await PersonTagEvent.find({ personTag: row._id }).sort({ _id: 1 })).map((e) => e.event)).toEqual(["opened", "closed"]);
  });
});

describe("the writers", () => {
  it("give / take / reopen keep one row per tag and write every step", async () => {
    const s = await makeStudent();
    await tags.give({ world: "real", personId: s._id, key: "hostels", by: "תמר" });
    await tags.give({ world: "real", personId: s._id, key: "hostels", by: "תמר" }); // no-op
    expect(await tags.holds(s._id, "real", "hostels")).toBe(true);
    await tags.take({ world: "real", personId: s._id, key: "hostels", by: "תמר", note: "עבר דירה" });
    expect(await tags.holds(s._id, "real", "hostels")).toBe(false);
    await tags.give({ world: "real", personId: s._id, key: "hostels", by: "תמר" });
    const hostelsTag = (await tags.tagMap("real")).get("hostels")._id;
    expect(await PersonTag.countDocuments({ person: s._id, tag: hostelsTag })).toBe(1);
    const row = await PersonTag.findOne({ person: s._id, tag: hostelsTag });
    expect((await PersonTagEvent.find({ personTag: row._id }).sort({ at: 1, _id: 1 })).map((e) => e.event)).toEqual(["opened", "closed", "reopened"]);
    const person = (await request(app).get(`/api/people/${s._id}`)).body.data.person;
    expect(person.tags.sort()).toEqual(["college", "hostels", "student"]);
    await expect(tags.give({ world: "real", personId: s._id, key: "nope" })).rejects.toMatchObject({ code: "TAG_UNKNOWN" });
  });

  it("a transfer between programs is two rows with otherTag on both events", async () => {
    const s = await makeStudent();
    await tags.give({ world: "real", personId: s._id, key: "college", at: "2026-01-01", by: "נעה" });
    await tags.take({ world: "real", personId: s._id, key: "college", at: "2026-06-01", by: "נעה", otherKey: "culture" });
    await tags.give({ world: "real", personId: s._id, key: "culture", at: "2026-06-01", by: "נעה", otherKey: "college" });
    const map = await tags.tagsByPerson("real", [s._id]);
    expect(map.get(String(s._id)).tags.sort()).toEqual(["culture", "student"]);
    expect(map.get(String(s._id)).pastTags).toEqual(["college"]);
    const ev = await PersonTagEvent.find({ world: "real", otherTag: { $ne: null } });
    expect(ev.map((e) => e.event).sort()).toEqual(["transferredIn", "transferredOut"]);
  });
});
