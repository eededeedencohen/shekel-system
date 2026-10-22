/**
 * שמרית's round (2026-10-19): the hostel's kind and contacts, a resident's
 * dates and "הוסף את כל דיירי ההוסטל", a teacher's papers, the supplier
 * file linked to a person, the monthly invoice round behind a teacher's
 * link, and the diary.
 */

const request = require("supertest");
const app = require("../../../app");
const Hostel = require("../../../models/Hostel");
const Invoice = require("../../../models/Invoice");
const InvoiceRequest = require("../../../models/InvoiceRequest");
const Lesson = require("../../../models/Lesson");
const Enrollment = require("../../../models/Enrollment");
const PersonDocument = require("../../../models/PersonDocument");
const StoredFile = require("../../../models/StoredFile");
const { Profile } = require("../../../models/profiles");
const tags = require("../../../services/tagService");
const { makeTeacher, makeStudent, makeHostel, makeCycle, makeSubject } = require("../../helpers/factories");

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMAGE = `data:image/png;base64,${PNG_B64}`;

describe("hostels: kind and contacts", () => {
  it("a hostel is a hostel by default; a קהילה is a kind, with its people by role", async () => {
    const res = await request(app).post("/api/hostels").send({
      name: "קהילת הבדיקה",
      kind: "community",
      contacts: [
        { name: "רונית", role: "manager", phone: "050-0000001" },
        { name: "דני", role: "reporter", phone: "050-0000002", email: "Dani@Example.org" },
      ],
    });
    expect(res.status).toBe(201);
    const h = res.body.data.hostel;
    expect(h.kind).toBe("community");
    expect(h.contacts).toHaveLength(2);
    expect(h.contacts[1]).toMatchObject({ name: "דני", role: "reporter", email: "dani@example.org" });

    const plain = await request(app).post("/api/hostels").send({ name: "הוסטל רגיל" });
    expect(plain.body.data.hostel.kind).toBe("hostel");

    const bad = await request(app).put(`/api/hostels/${h._id}`).send({ contacts: [{ name: "", role: "manager" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("HOSTEL_CONTACT_INVALID");
    const badKind = await request(app).put(`/api/hostels/${h._id}`).send({ kind: "palace" });
    expect(badKind.body.code).toBe("HOSTEL_KIND_INVALID");
  });
});

describe("POST /api/enrollments/residents", () => {
  it("seats every current resident of the hostel, gives the הוסטלים tag where missing, skips who is in", async () => {
    const hostel = await makeHostel();
    const teacher = await makeTeacher();
    const cycle = await makeCycle({ hostel: hostel._id, teacher: teacher._id });
    await tags.setCycleProgram({ world: "real", cycleId: cycle._id, key: "hostels" });
    const a = await makeStudent({ residence: { hostel: hostel._id, since: new Date("2026-01-01") } });
    const b = await makeStudent({ residence: { hostel: hostel._id } });
    const gone = await makeStudent({ residence: { hostel: hostel._id, until: new Date("2026-02-01") } });
    await makeStudent(); // lives elsewhere
    await tags.give({ world: "real", personId: b._id, key: "hostels" });
    await request(app).post("/api/enrollments").send({ cycle: cycle._id, student: b._id });

    const res = await request(app).post("/api/enrollments/residents").send({ cycle: cycle._id, createdBy: "שמרית" });
    expect(res.status).toBe(201);
    expect(res.body.data.enrollments.map((e) => String(e.student._id))).toEqual([String(a._id)]);
    expect(res.body.data.skipped).toBe(1);
    expect(res.body.data.tagged).toBe(1);
    expect(await tags.holds(a._id, "real", "hostels")).toBe(true);
    expect(await Enrollment.countDocuments({ cycle: cycle._id, status: "active" })).toBe(2);
    expect(await Enrollment.exists({ cycle: cycle._id, student: gone._id })).toBeNull();
    const prof = await Profile.findOne({ person: a._id });
    expect(prof.residence.since).toBeTruthy();
  });

  it("refuses a college cycle", async () => {
    const cycle = await makeCycle();
    const res = await request(app).post("/api/enrollments/residents").send({ cycle: cycle._id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_A_HOSTEL_CYCLE");
  });
});

describe("a person's documents", () => {
  it("files a syllabus on a teacher, lists it (also for the world), serves the bytes, removes it", async () => {
    const t = await makeTeacher();
    const res = await request(app).post(`/api/people/${t._id}/documents`).send({ kind: "syllabus", label: "סילבוס תשפ״ז", fileName: "syllabus.png", mime: "image/png", data: IMAGE });
    expect(res.status).toBe(201);
    const d = res.body.data.document;
    expect(d).toMatchObject({ kind: "syllabus", label: "סילבוס תשפ״ז", name: "syllabus.png", mime: "image/png" });
    expect(await StoredFile.countDocuments()).toBe(1);

    const list = await request(app).get(`/api/people/${t._id}/documents`);
    expect(list.body.data.documents).toHaveLength(1);
    const all = await request(app).get("/api/people/documents");
    expect(all.body.data.documents.map((x) => x._id)).toEqual([d._id]);

    const file = await request(app).get(`/api/people/${t._id}/documents/${d._id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/image\/png/);

    const bad = await request(app).post(`/api/people/${t._id}/documents`).send({ kind: "syllabus", fileName: "x.exe", mime: "application/x-msdownload", data: IMAGE });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("PERSON_DOCUMENT_INVALID");

    const del = await request(app).delete(`/api/people/${t._id}/documents/${d._id}`);
    expect(del.status).toBe(204);
    expect(await PersonDocument.countDocuments()).toBe(0);
    expect(await StoredFile.countDocuments()).toBe(0);
  });
});

describe("a supplier file linked to a person", () => {
  it("creates the file with its teacher, refuses a person who is not there, unlinks", async () => {
    const t = await makeTeacher();
    const res = await request(app).post("/api/suppliers").send({ firstName: "אביה", lastName: "טסט", gender: "female", phone: "0501234567", person: t._id });
    expect(res.status).toBe(201);
    expect(String(res.body.data.supplier.person)).toBe(String(t._id));
    const bad = await request(app).post("/api/suppliers").send({ firstName: "א", lastName: "ב", gender: "male", phone: "0501234567", person: "6a09522ce6b8b28c96fdaa69" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("SUPPLIER_PERSON_INVALID");
    const off = await request(app).patch(`/api/suppliers/${res.body.data.supplier._id}`).send({ person: null });
    expect(off.body.data.supplier.person).toBeNull();
  });
});

/** A hostel teacher with a weekly course live in 2026-10 (Thursdays 15:00-16:00) and one in the college. */
async function hostelMonth() {
  const hostel = await makeHostel({ name: "שיירות" });
  const subject = await makeSubject({ name: "עיצוב גרפי" });
  const teacher = await makeTeacher({ firstName: "אביה", lastName: "טסט", gender: "female" });
  const cycle = await makeCycle({ subject: subject._id, teacher: teacher._id, hostel: hostel._id, startDate: new Date("2026-09-01"), endDate: new Date("2026-12-31"), schedule: [{ day: 4, start: "15:00", end: "16:00" }] });
  await tags.setCycleProgram({ world: "real", cycleId: cycle._id, key: "hostels" });
  const college = await makeCycle({ teacher: teacher._id, startDate: new Date("2026-09-01"), endDate: new Date("2026-12-31"), schedule: [{ day: 1, start: "10:00", end: "11:00" }] });
  return { hostel, teacher, cycle, college };
}

describe("the monthly invoice round", () => {
  it("opens a month for the hostels: one request per teacher with the planned sessions; twice is refused", async () => {
    const { teacher, cycle } = await hostelMonth();
    const res = await request(app).post("/api/invoice-rounds").send({ month: "2026-10", program: "hostels" });
    expect(res.status).toBe(201);
    const round = res.body.data.round;
    expect(round).toMatchObject({ month: "2026-10", program: "hostels", monthLabel: "אוקטובר 2026" });
    expect(round.requests).toHaveLength(1);
    const r = round.requests[0];
    expect(String(r.teacher._id)).toBe(String(teacher._id));
    expect(r.status).toBe("new");
    // the Thursdays of October 2026: 1, 8, 15, 22, 29 - the hostel course only, never the college one
    expect(r.sessions.map((s) => s.date.slice(0, 10))).toEqual(["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29"]);
    expect(r.sessions.every((s) => String(s.cycle._id) === String(cycle._id))).toBe(true);
    expect(r.counts).toMatchObject({ sessions: 5, unbilled: 5, billed: 0 });
    expect(r.token).toMatch(/^[\w-]{12,}$/);
    expect(r.linkLive).toBe(true);

    const again = await request(app).post("/api/invoice-rounds").send({ month: "2026-10", program: "hostels" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("INVOICE_ROUND_EXISTS");
    const empty = await request(app).post("/api/invoice-rounds").send({ month: "2025-01", program: "hostels" });
    expect(empty.body.code).toBe("INVOICE_ROUND_NO_TEACHERS");
    const badMonth = await request(app).post("/api/invoice-rounds").send({ month: "10/2026" });
    expect(badMonth.body.code).toBe("INVOICE_ROUND_MONTH");
  });

  it("the teacher behind the link: opens, attaches the invoice to the lessons it covers, finishes; the coordinator sees it all", async () => {
    const { teacher, cycle } = await hostelMonth();
    // the coordinator already reported attendance on the 1st
    const student = await makeStudent();
    await Lesson.create({ cycle: cycle._id, date: new Date("2026-10-01T00:00:00.000Z"), attendance: [{ student: student._id, status: "Present" }] });
    const opened = (await request(app).post("/api/invoice-rounds").send({ month: "2026-10" })).body.data.round;
    const req0 = opened.requests[0];
    expect(req0.sessions[0]).toMatchObject({ reported: true, present: 1, invoice: null });
    expect(req0.counts).toMatchObject({ sessions: 5, billed: 0, unbilled: 5, reported: 1, reportedNotBilled: 1 });

    const sent = await request(app).post(`/api/invoice-rounds/${opened._id}/requests/${req0._id}/sent`).send({});
    expect(sent.body.data.round.requests[0].status).toBe("sent");

    const url = `/api/public/invoices/${req0.token}`;
    const view = (await request(app).get(url)).body.data.view;
    expect(view).toMatchObject({ month: "2026-10", monthLabel: "אוקטובר 2026", done: false, world: "real" });
    // a link carries no world: the token says where it lives (utils/tokenWorld); a world named by the request still wins
    expect((await request(app).get(url).set("X-Dataset", "test")).status).toBe(404);
    await InvoiceRequest.collection.updateOne({ token: req0.token }, { $set: { world: "test" } }); // the raw driver: `world` is stamped, never updated through mongoose
    const { tokenWorld } = require("../../../utils/tokenWorld");
    const fakeReq = { params: { token: req0.token }, method: "GET", query: {}, world: "real", get: () => undefined };
    await new Promise((resolve, reject) => tokenWorld([[InvoiceRequest, "token"]])(fakeReq, {}, (e) => (e ? reject(e) : resolve())));
    expect(fakeReq.world).toBe("test");
    const named = { ...fakeReq, world: "real", get: (h) => (h === "x-dataset" ? "real" : undefined) };
    await new Promise((resolve, reject) => tokenWorld([[InvoiceRequest, "token"]])(named, {}, (e) => (e ? reject(e) : resolve())));
    expect(named.world).toBe("real");
    await InvoiceRequest.collection.updateOne({ token: req0.token }, { $set: { world: "real" } });
    expect(view.teacher).toMatchObject({ firstName: "אביה", gender: "female" });
    expect(view.courses).toHaveLength(1);
    expect(view.courses[0].name).toBe("עיצוב גרפי · הוסטל שיירות");
    expect(view.courses[0].sessions).toHaveLength(5);
    expect((await InvoiceRequest.findById(req0._id)).openedAt).toBeTruthy();
    expect((await request(app).get(`/api/invoice-rounds/${opened._id}`)).body.data.round.requests[0].status).toBe("opened");

    const ids = view.courses[0].sessions.map((s) => s._id);
    expect(view.courses[0].sessions[0]).toMatchObject({ reported: true, present: 1, invoice: null });
    // nothing to finish with yet; the invoice must name its lessons, and only this month's
    expect((await request(app).post(`${url}/done`).send({})).body.code).toBe("INVOICE_DONE_EMPTY");
    expect((await request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: "oct.png" })).body.code).toBe("INVOICE_NO_SESSIONS");
    expect((await request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: "oct.png", sessions: [ids[0], "6ad6000000000000000000aa"] })).body.code).toBe("INVOICE_SESSION_UNKNOWN");

    const up = await request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: "oct.png", sessions: [ids[0], ids[1]] });
    expect(up.status).toBe(200);
    expect(up.body.data.view.invoices).toHaveLength(1);
    expect(up.body.data.view.invoices[0].lessons.map((l) => l.date.slice(0, 10))).toEqual(["2026-10-01", "2026-10-08"]);
    expect(up.body.data.view.counts).toMatchObject({ billed: 2, unbilled: 3 });
    // the session of the 8th got a lesson row; the 1st kept the reported one
    expect(await Lesson.countDocuments({ cycle: cycle._id })).toBe(2);
    const inv = await Invoice.findOne({});
    expect(String(inv.request)).toBe(String(req0._id));
    expect(String(inv.teacher)).toBe(String(teacher._id));
    expect(inv.uploadedBy).toBe("אביה טסט");
    const image = await request(app).get(`${url}/invoices/${inv._id}/image`);
    expect(image.status).toBe(200);
    // a lesson sits on one invoice only
    expect((await request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: "again.png", sessions: [ids[0]] })).body.code).toBe("INVOICE_LESSON_BILLED");

    const done = await request(app).post(`${url}/done`).send({ note: "לימדתי גם ב-3.10" });
    expect(done.body.data.view.done).toBe(true);
    const after = await request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: "late.png", sessions: [ids[2]] });
    expect(after.status).toBe(400);
    expect(after.body.code).toBe("INVOICE_LINK_DONE");

    const staff = (await request(app).get("/api/invoice-rounds")).body.data.rounds[0];
    expect(staff.counts).toMatchObject({ teachers: 1, done: 1, invoices: 1, mismatches: 1 });
    const r = staff.requests[0];
    expect(r).toMatchObject({ status: "done", note: "לימדתי גם ב-3.10" });
    expect(r.counts).toMatchObject({ billed: 2, unbilled: 3, reported: 1, billedNotReported: 1, reportedNotBilled: 0 });
    expect(r.invoices[0].lessons).toHaveLength(2);

    // the coordinator opens it back, closes the month with the mail, and may not delete a round with invoices
    const reopened = await request(app).post(`/api/invoice-rounds/${opened._id}/requests/${req0._id}/reopen`).send({});
    expect(reopened.body.data.round.requests[0].status).toBe("partial");
    const mail = await request(app).post(`/api/invoice-rounds/${opened._id}/mail`).send({ sent: true });
    expect(mail.body.data.round.mail.sentAt).toBeTruthy();
    const del = await request(app).delete(`/api/invoice-rounds/${opened._id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("INVOICE_ROUND_HAS_INVOICES");
  });

  it("an unknown or expired link answers so; a round without invoices can be deleted", async () => {
    await hostelMonth();
    const opened = (await request(app).post("/api/invoice-rounds").send({ month: "2026-10" })).body.data.round;
    expect((await request(app).get("/api/public/invoices/not-a-real-token-at-all")).status).toBe(404);
    await InvoiceRequest.updateOne({ _id: opened.requests[0]._id }, { expiresAt: new Date(Date.now() - 1000) });
    const expired = await request(app).get(`/api/public/invoices/${opened.requests[0].token}`);
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe("INVOICE_LINK_EXPIRED");
    const renewed = await request(app).post(`/api/invoice-rounds/${opened._id}/requests/${opened.requests[0]._id}/renew`).send({ days: 7 });
    expect(renewed.body.data.round.requests[0].linkLive).toBe(true);
    expect((await request(app).delete(`/api/invoice-rounds/${opened._id}`)).status).toBe(204);
    expect(await InvoiceRequest.countDocuments()).toBe(0);
  });
});

describe("/api/diary", () => {
  it("keeps the acting account's notes and tasks, by day; a task is done or not", async () => {
    const res = await request(app).post("/api/diary").send({ date: "2026-10-15", kind: "task", title: "לבקש סילבוס מאביה", body: "אחרי פגישת המורים" });
    expect(res.status).toBe(201);
    const e = res.body.data.entry;
    expect(e).toMatchObject({ date: "2026-10-15", kind: "task", title: "לבקש סילבוס מאביה", done: false });
    await request(app).post("/api/diary").send({ date: "2026-11-02", title: "המורה טס לחו״ל" });
    const list = await request(app).get("/api/diary?from=2026-10-01&to=2026-10-31");
    expect(list.body.data.entries.map((x) => x.title)).toEqual(["לבקש סילבוס מאביה"]);
    const done = await request(app).patch(`/api/diary/${e._id}`).send({ done: true });
    expect(done.body.data.entry.done).toBe(true);
    expect(done.body.data.entry.doneAt).toBeTruthy();
    const bad = await request(app).post("/api/diary").send({ date: "15.10.2026", title: "x" });
    expect(bad.body.code).toBe("DIARY_INVALID");
    expect((await request(app).delete(`/api/diary/${e._id}`)).status).toBe(204);
    expect((await request(app).get("/api/diary")).body.data.entries).toHaveLength(1);
  });
});
