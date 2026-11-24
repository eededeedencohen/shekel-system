/**
 * The waiting lists of מכללה לכל (Eden, 2026-11-24: "יהיה תור לרשימות.
 * סטודנט יוכל להיות בכמה רשימות… במקרה שסטודנט משובץ לשאול אם להסיר אותו
 * מהרשימות האחרות ומאיזה"; "אם יש סטודנטים קיימים… תן להם רפרנס, אבל אם לא
 * קיימים אז תשאיר להם כרטיס"): a list per subject, a queue in each, a row
 * for a person of the system or for a written name alone.
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { makeStudent, makeSubject, makeCycle } = require("../../helpers/factories");
const WaitEntry = require("../../../models/WaitEntry");

afterEach(() => {
  TEST_ACCOUNT.kind = "super";
});

const api = "/api/wait-lists";
const board = async () => (await request(app).get(api)).body.data;
const newList = (body) => request(app).post(api).send(body);
const add = (body) => request(app).post(`${api}/entries`).send(body);
const patch = (id, body) => request(app).patch(`${api}/entries/${id}`).send(body);
const end = (id, body) => request(app).post(`${api}/entries/${id}/end`).send(body);
const queue = (data, list) => data.entries.filter((e) => String(e.list) === String(list) && e.state === "waiting").sort((a, b) => a.rank - b.rank);
const names = (data, list) => queue(data, list).map((e) => e.name);

async function twoLists() {
  const subject = await makeSubject({ name: "מוסיקה" });
  const a = (await newList({ name: "מוסיקה", subject: subject._id })).body.data.lists[0];
  const b = (await newList({ name: "ערבית" })).body.data.lists[1];
  return { a, b, subject };
}

describe("the waiting lists", () => {
  it("opens lists, with or without a subject of the system, and never two by one name", async () => {
    const { a, b, subject } = await twoLists();
    expect(String(a.subject)).toBe(String(subject._id));
    expect(b.subject).toBeNull();
    expect((await newList({ name: " ערבית " })).status).toBe(409);
    expect((await newList({ name: "" })).status).toBe(400);
    expect((await newList({ name: "ציור", subject: "nope" })).status).toBe(400);
    const r = await request(app).patch(`${api}/${b._id}`).send({ name: "ערבית מדוברת", note: "אין עדיין קורס" });
    expect(r.body.data.lists.map((l) => l.name)).toEqual(["מוסיקה", "ערבית מדוברת"]);
  });

  it("queues whoever enters last, a person of the system beside a written name, and nobody twice in one list", async () => {
    const { a } = await twoLists();
    const student = await makeStudent({ firstName: "תמר", lastName: "אלון" });
    await add({ list: a._id, name: "  יואב   שגיא ", note: "גיטרה" });
    const r = await add({ list: a._id, person: student._id });
    expect(r.status).toBe(201);
    expect(names(r.body.data, a._id)).toEqual(["יואב שגיא", "תמר אלון"]);
    const [written, known] = queue(r.body.data, a._id);
    expect(written.who).toBeNull();
    expect(written.note).toBe("גיטרה");
    expect(known.who).toMatchObject({ firstName: "תמר", lastName: "אלון", inScope: true });
    expect(known.who.programs).toContain("college");
    expect(known.since).toBeTruthy();
    expect((await add({ list: a._id, person: student._id })).status).toBe(409);
    expect((await add({ list: a._id, name: "יואב שגיא" })).status).toBe(409);
    expect((await add({ list: a._id })).status).toBe(400);
    // a row from the old sheet holds no date
    const s = await add({ list: a._id, name: "נועם ברק", source: "sheet" });
    expect(queue(s.body.data, a._id)[2]).toMatchObject({ source: "sheet", since: null });
  });

  it("moves a row in its queue with a reason, and to another list as the last there", async () => {
    const { a, b } = await twoLists();
    for (const name of ["א", "ב", "ג"]) await add({ list: a._id, name });
    await add({ list: b._id, name: "ד" });
    let data = await board();
    const third = queue(data, a._id)[2];
    data = (await patch(third._id, { at: 0, why: "מחכה כבר שנה" })).body.data;
    expect(names(data, a._id)).toEqual(["ג", "א", "ב"]);
    expect(queue(data, a._id)[0].moved).toMatchObject({ why: "מחכה כבר שנה" });
    expect(queue(data, a._id).map((e) => e.rank)).toEqual([0, 1, 2]);
    data = (await patch(third._id, { list: b._id })).body.data;
    expect(names(data, a._id)).toEqual(["א", "ב"]);
    expect(names(data, b._id)).toEqual(["ד", "ג"]);
    // already there: the move is refused, and nothing changed
    await add({ list: a._id, name: "ד" });
    const twice = queue(await board(), a._id).find((e) => e.name === "ד");
    expect((await patch(twice._id, { list: b._id })).status).toBe(409);
  });

  it("says once how many courses a person wants, for every list the person waits in", async () => {
    const { a, b } = await twoLists();
    await add({ list: a._id, name: "תמר אלון" });
    await add({ list: b._id, name: "תמר אלון", wants: "one" });
    let data = await board();
    expect(data.entries.map((e) => e.wants)).toEqual(["one", "one"]);
    data = (await patch(data.entries[0]._id, { wants: "many" })).body.data;
    expect(data.entries.map((e) => e.wants)).toEqual(["many", "many"]);
    expect((await patch(data.entries[0]._id, { wants: "lots" })).status).toBe(400);
  });

  it("links a written name to a person of the system in every list it stands in, and lets it go", async () => {
    const { a, b } = await twoLists();
    const student = await makeStudent({ firstName: "תמר", lastName: "אלון" });
    await add({ list: a._id, name: "תמר אלון" });
    await add({ list: b._id, name: "תמר אלון" });
    let data = await board();
    data = (await patch(data.entries[0]._id, { person: student._id })).body.data;
    expect(data.entries.map((e) => String(e.person))).toEqual([String(student._id), String(student._id)]);
    expect(data.entries.every((e) => e.who.inScope)).toBe(true);
    data = (await patch(data.entries[1]._id, { person: null })).body.data;
    expect(data.entries.map((e) => e.person)).toEqual([null, null]);
    expect(data.entries.map((e) => e.name)).toEqual(["תמר אלון", "תמר אלון"]);
  });

  it("places a person and takes them off the other lists that were ticked, and brings a row back where it stood", async () => {
    const { a, b, subject } = await twoLists();
    const c = (await newList({ name: "ציור" })).body.data.lists[2];
    const cycle = await makeCycle({ subject: subject._id });
    await add({ list: a._id, name: "תמר אלון" });
    await add({ list: a._id, name: "יואב שגיא" });
    await add({ list: b._id, name: "תמר אלון" });
    await add({ list: c._id, name: "תמר אלון" });
    let data = await board();
    const mine = data.entries.filter((e) => e.name === "תמר אלון");
    const [inA, inB, inC] = [a, b, c].map((l) => mine.find((e) => String(e.list) === String(l._id)));
    // a row of somebody else cannot be taken along
    const other = data.entries.find((e) => e.name === "יואב שגיא");
    expect((await end(inA._id, { reason: "placed", also: [other._id] })).status).toBe(400);
    data = (await end(inA._id, { reason: "placed", course: cycle._id, also: [inB._id] })).body.data;
    const after = (id) => data.entries.find((e) => String(e._id) === String(id));
    expect(after(inA._id)).toMatchObject({ state: "placed", endReason: "placed" });
    expect(String(after(inA._id).course)).toBe(String(cycle._id));
    expect(after(inB._id)).toMatchObject({ state: "left", endReason: "elsewhere" });
    expect(after(inC._id).state).toBe("waiting");
    expect(names(data, a._id)).toEqual(["יואב שגיא"]);
    expect((await end(inA._id, { reason: "asked" })).status).toBe(409);
    // back: first in its list again
    data = (await request(app).post(`${api}/entries/${inA._id}/back`)).body.data;
    expect(names(data, a._id)).toEqual(["תמר אלון", "יואב שגיא"]);
    expect(after(inA._id).endReason).toBeNull();
    expect((await end(inC._id, { reason: "whatever" })).status).toBe(400);
    data = (await end(inC._id, { reason: "noAnswer", note: "שלוש שיחות" })).body.data;
    expect(after(inC._id)).toMatchObject({ state: "left", endReason: "noAnswer", endNote: "שלוש שיחות" });
  });

  it("closes a list only once nobody waits in it, and deletes a row entered by mistake", async () => {
    const { a, b } = await twoLists();
    await add({ list: a._id, name: "תמר אלון" });
    expect((await request(app).delete(`${api}/${a._id}`)).status).toBe(409);
    let data = await board();
    data = (await request(app).delete(`${api}/entries/${data.entries[0]._id}`)).body.data;
    expect(data.entries).toEqual([]);
    expect(await WaitEntry.countDocuments()).toBe(0);
    data = (await request(app).delete(`${api}/${a._id}`)).body.data;
    expect(data.lists.map((l) => String(l._id))).toEqual([String(b._id)]);
  });

  it("is the college managers' and the super admin's; a manager adds only a person of their own", async () => {
    const { a } = await twoLists();
    const student = await makeStudent();
    for (const kind of ["social", "culture", "hostels", "teacher"]) {
      TEST_ACCOUNT.kind = kind;
      expect((await request(app).get(api)).status).toBe(403);
      expect((await add({ list: a._id, name: "מישהו" })).status).toBe(403);
    }
    TEST_ACCOUNT.kind = "manager";
    expect((await request(app).get(api)).status).toBe(200);
    expect((await add({ list: a._id, person: student._id })).status).toBe(201);
    expect((await add({ list: a._id, person: "64b000000000000000000001" })).status).toBe(404);
  });
});
