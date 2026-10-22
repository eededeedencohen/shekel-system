/**
 * שמרית's round (2026-10-19): the hostel's kind and contacts, a resident's
 * dates and "הוסף את כל דיירי ההוסטל", a teacher's papers, the supplier
 * file linked to a person, the monthly invoice round behind a teacher's
 * link, and the diary.
 */

const request = require("supertest");
const app = require("../../../app");
const Hostel = require("../../../models/Hostel");
const Cycle = require("../../../models/Cycle");
const Invoice = require("../../../models/Invoice");
const InvoiceLesson = require("../../../models/InvoiceLesson");
const InvoiceRound = require("../../../models/InvoiceRound");
const InvoiceRequest = require("../../../models/InvoiceRequest");
const AdminAction = require("../../../models/AdminAction");
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

/* The state machine of the invoices (project-files/specs/hostels/invoice-state-machine.html, 2026-10-22): the decisions
   taken there and the super admin's corrections. */
describe("the state machine of the invoices (2026-10-22)", () => {
  /** A month opened for אביה: the round, her request, her link's url (opened once), and her session ids. */
  async function monthOpened() {
    const base = await hostelMonth();
    const round = (await request(app).post("/api/invoice-rounds").send({ month: "2026-10" })).body.data.round;
    const req0 = round.requests[0];
    const url = `/api/public/invoices/${req0.token}`;
    const view = (await request(app).get(url)).body.data.view;
    return { ...base, round, req0, url, ids: view.courses[0].sessions.map((s) => s._id) };
  }
  const staffRequest = async (roundId) => (await request(app).get(`/api/invoice-rounds/${roundId}`)).body.data.round.requests[0];
  const admin = (roundId, body) => request(app).post(`/api/invoice-rounds/${roundId}/admin`).send(body);
  const upload = (url, sessions, name = "a.png") => request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: name, sessions });

  it("the mail closes the links and taking it back opens them; a finished teacher still reads the summary after the link expired", async () => {
    const { round, req0, url, ids } = await monthOpened();
    await upload(url, [ids[0]]);
    await request(app).post(`${url}/done`).send({});
    await request(app).post(`/api/invoice-rounds/${round._id}/mail`).send({ sent: true });
    expect((await staffRequest(round._id)).linkLive).toBe(false);
    // decision 12: the finished teacher reads, with the pictures, and cannot act
    const view = await request(app).get(url);
    expect(view.status).toBe(200);
    expect(view.body.data.view).toMatchObject({ done: true, linkLive: false });
    expect((await request(app).get(`${url}/invoices/${view.body.data.view.invoices[0]._id}/image`)).status).toBe(200);
    expect((await upload(url, [ids[1]])).status).toBe(410);
    // decision 2: the mail taken back opens the links again
    await request(app).post(`/api/invoice-rounds/${round._id}/mail`).send({ sent: false });
    expect((await staffRequest(round._id)).linkLive).toBe(true);
    // an unfinished teacher whose link expired is still shut out
    await request(app).post(`/api/invoice-rounds/${round._id}/requests/${req0._id}/reopen`).send({});
    await InvoiceRequest.updateOne({ _id: req0._id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await request(app).get(url)).status).toBe(410);
  });

  it("a session a substitute taught is the substitute's: flagged on both sides, refused on the link, billed from their file", async () => {
    const { cycle, round, url, ids } = await monthOpened();
    const sub = await makeTeacher({ firstName: "מחליף", lastName: "טסט" });
    await Lesson.create({ cycle: cycle._id, date: new Date("2026-10-08T00:00:00.000Z"), teacher: sub._id });
    const view = (await request(app).get(url)).body.data.view;
    expect(view.courses[0].sessions[1].substitute).toMatchObject({ name: "מחליף טסט" });
    expect(view.courses[0].sessions[0].substitute).toBeNull();
    expect(view.counts).toMatchObject({ sessions: 5, substituted: 1, unbilled: 4 });
    const bad = await upload(url, [ids[1]]);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVOICE_SESSION_SUBSTITUTE");
    const staff = await staffRequest(round._id);
    expect(staff.sessions[1].substitute.name).toBe("מחליף טסט");
    // the substitute bills it from their own file: the session reads billed, the invoice is not the teacher's
    expect((await request(app).post("/api/invoices").send({ teacher: sub._id, lessons: [staff.sessions[1].lesson], imageData: IMAGE, imageName: "sub.png" })).status).toBe(201);
    const after = await staffRequest(round._id);
    expect(after.invoices).toHaveLength(0);
    expect(after.sessions[1].invoice).toBeTruthy();
    expect(after.counts).toMatchObject({ billed: 0, substituted: 1 });
  });

  it("an invoice uploaded from the teacher's file on the month's lessons belongs to the request on both sides (decision 7)", async () => {
    const { teacher, round, url, ids } = await monthOpened();
    const staff0 = await staffRequest(round._id);
    const lesson = await Lesson.create({ cycle: staff0.sessions[2].cycle._id, date: new Date("2026-10-15T00:00:00.000Z") });
    const manual = await request(app).post("/api/invoices").send({ teacher: teacher._id, lessons: [lesson._id], imageData: IMAGE, imageName: "file.png", by: "שמרית" });
    expect(manual.status).toBe(201);
    expect(manual.body.data.invoice).toMatchObject({ viaLink: false, locked: null });
    const staff = await staffRequest(round._id);
    expect(staff.invoices).toHaveLength(1);
    expect(staff.invoices[0]).toMatchObject({ viaLink: false });
    expect(staff.sessions[2].invoice).toBe(String(manual.body.data.invoice._id));
    expect(staff.counts).toMatchObject({ billed: 1 });
    expect(staff.status).toBe("partial");
    const view = (await request(app).get(url)).body.data.view;
    expect(view.invoices).toHaveLength(1);
    expect(view.invoices[0].fromFile).toBe(true);
    expect((await request(app).get(`${url}/invoices/${view.invoices[0]._id}/image`)).status).toBe(200);
    // never the teacher's to take back; the session is billed for the link
    expect((await request(app).delete(`${url}/invoices/${view.invoices[0]._id}`)).body.code).toBe("INVOICE_NOT_YOURS");
    expect((await upload(url, [ids[2]])).body.code).toBe("INVOICE_LESSON_BILLED");
  });

  it("a billed lesson cannot be deleted; a lesson row that vanished heals on the next upload (case 19)", async () => {
    const { round, url, ids } = await monthOpened();
    expect((await upload(url, [ids[0]])).status).toBe(200);
    const staff = await staffRequest(round._id);
    const del = await request(app).delete(`/api/lessons/${staff.sessions[0].lesson}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("LESSON_BILLED");
    // the request remembers a row that someone deleted by hand
    const r = await InvoiceRequest.findById(staff._id);
    const stray = await Lesson.create({ cycle: r.sessions[1].cycle, date: r.sessions[1].date });
    r.sessions[1].lesson = stray._id;
    await r.save();
    await Lesson.deleteOne({ _id: stray._id });
    const healed = await upload(url, [ids[1]], "b.png");
    expect(healed.status).toBe(200);
    expect(healed.body.data.view.counts.billed).toBe(2);
  });

  it("the super admin's corrections: every action rewrites the facts, keeps the five rules and leaves a line", async () => {
    const { hostel, cycle, round, req0, url, ids } = await monthOpened();

    // A: an invoice of a finished teacher goes, and the finish with it when nothing is left (rule 4); the lesson rows stay
    await upload(url, [ids[0], ids[1]]);
    await request(app).post(`${url}/done`).send({});
    const a = await admin(round._id, { action: "invoiceDelete", invoice: (await staffRequest(round._id)).invoices[0]._id });
    expect(a.status).toBe(200);
    expect(a.body.data.did).toMatchObject({ invoices: 1, files: 1, invoiceLessons: 2, reopened: 1 });
    expect(a.body.data.round.requests[0]).toMatchObject({ status: "opened", completedAt: null });
    expect(await Invoice.countDocuments()).toBe(0);
    expect(await StoredFile.countDocuments()).toBe(0);
    expect(await Lesson.countDocuments({ cycle: cycle._id })).toBe(2);
    expect((await admin(round._id, { action: "invoiceDelete", invoice: "6ad6000000000000000000aa" })).status).toBe(404);

    // B: a reset keeps the token (decision 3) and opens three weeks; with rotateToken the old link dies
    await upload(url, [ids[0]]);
    await request(app).post(`${url}/done`).send({ note: "זהו" });
    const b = await admin(round._id, { action: "requestReset", request: req0._id });
    expect(b.body.data.did).toMatchObject({ invoices: 1, requests: 1 });
    expect(b.body.data.round.requests[0]).toMatchObject({ status: "new", token: req0.token, note: null, openedAt: null, completedAt: null, linkLive: true });
    const fresh = (await admin(round._id, { action: "requestReset", request: req0._id, rotateToken: true })).body.data.round.requests[0];
    expect(fresh.token).not.toBe(req0.token);
    expect((await request(app).get(url)).status).toBe(404);
    const url2 = `/api/public/invoices/${fresh.token}`;
    expect((await request(app).get(url2)).status).toBe(200);

    // D: the course moved to Mondays - the billed Thursday stays, the rest follow the schedule
    await upload(url2, [ids[0]]);
    await Cycle.updateOne({ _id: cycle._id }, { schedule: [{ day: 1, start: "10:00", end: "11:00" }] });
    const d = await admin(round._id, { action: "sessionsRebuild", request: req0._id });
    expect(d.body.data.did).toMatchObject({ kept: 1, sessions: 5 });
    expect(d.body.data.round.requests[0].sessions.map((s) => s.date.slice(0, 10))).toEqual(["2026-10-01", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(d.body.data.round.requests[0].counts.billed).toBe(1);

    // E: a teacher whose course came after the opening gets a link; a second sync adds nobody
    const late = await makeTeacher({ firstName: "מאוחר", lastName: "טסט" });
    const lateCycle = await makeCycle({ subject: cycle.subject, teacher: late._id, hostel: hostel._id, startDate: new Date("2026-10-10"), endDate: new Date("2026-12-31"), schedule: [{ day: 2, start: "12:00", end: "13:00" }] });
    await tags.setCycleProgram({ world: "real", cycleId: lateCycle._id, key: "hostels" });
    const e = await admin(round._id, { action: "requestsSync" });
    expect(e.body.data.did.requests).toBe(1);
    expect(e.body.data.round.requests).toHaveLength(2);
    const lateReq = e.body.data.round.requests.find((r) => String(r.teacher._id) === String(late._id));
    expect(lateReq.status).toBe("new");
    expect(lateReq.sessions.map((s) => s.date.slice(0, 10))).toEqual(["2026-10-13", "2026-10-20", "2026-10-27"]);
    expect((await admin(round._id, { action: "requestsSync" })).body.data.did.requests).toBe(0);

    // C: a teacher with invoices leaves only with force; a lesson row that carries attendance stays (rule 2)
    await upload(`/api/public/invoices/${lateReq.token}`, [lateReq.sessions[0]._id]);
    const refused = await admin(round._id, { action: "requestRemove", request: lateReq._id });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("INVOICE_REQUEST_HAS_INVOICES");
    const lateLesson = (await InvoiceRequest.findById(lateReq._id)).sessions[0].lesson;
    const student = await makeStudent();
    await Lesson.updateOne({ _id: lateLesson }, { attendance: [{ student: student._id, status: "Present" }] });
    const c = await admin(round._id, { action: "requestRemove", request: lateReq._id, force: true });
    expect(c.body.data.did).toMatchObject({ invoices: 1, requests: 1, lessons: 0 });
    expect(await Lesson.countDocuments({ _id: lateLesson })).toBe(1);
    expect(c.body.data.round.requests).toHaveLength(1);

    // F: the round back to the morning it opened - the mail off, every request new, the links open
    await request(app).post(`/api/invoice-rounds/${round._id}/mail`).send({ sent: true });
    const f = await admin(round._id, { action: "roundReset" });
    expect(f.body.data.round.mail.sentAt).toBeNull();
    expect(f.body.data.round.requests[0]).toMatchObject({ status: "new", linkLive: true, token: fresh.token });
    expect(f.body.data.did).toMatchObject({ invoices: 1, requests: 1 });
    expect(await Invoice.countDocuments()).toBe(0);

    // H: orphans counted (dryRun), then fixed; the invoice left without lessons is listed for A
    const invH = (await upload(url2, [ids[0]])).body.data.view.invoices[0];
    const rH = await InvoiceRequest.findById(req0._id);
    const billedRow = rH.sessions[0].lesson;
    const stray = await Lesson.create({ cycle: cycle._id, date: rH.sessions[1].date });
    rH.sessions[1].lesson = stray._id;
    await rH.save();
    await Lesson.deleteOne({ _id: stray._id });
    await Lesson.deleteOne({ _id: billedRow });
    const dry = await admin(round._id, { action: "orphanSweep", dryRun: true });
    expect(dry.body.data.did.sweep).toMatchObject({ rowsWithoutInvoice: 0, rowsWithoutLesson: 1, deadPointers: 2, fixed: false });
    expect(dry.body.data.did.sweep.invoicesWithoutLessons.map((i) => String(i._id))).toEqual([String(invH._id)]);
    expect(await InvoiceLesson.countDocuments()).toBe(1);
    const fix = await admin(round._id, { action: "orphanSweep" });
    expect(fix.body.data.did.sweep).toMatchObject({ rowsWithoutLesson: 1, deadPointers: 2, fixed: true });
    expect(await InvoiceLesson.countDocuments()).toBe(0);
    const healed = await InvoiceRequest.findById(req0._id);
    expect(healed.sessions[0].lesson).toBeNull();
    expect(healed.sessions[1].lesson).toBeNull();
    expect((await admin(round._id, { action: "invoiceDelete", invoice: invH._id })).body.data.did).toMatchObject({ invoices: 1, invoiceLessons: 0 });

    // G: the round with everything in it; the bare lesson row its link made goes (rule 2), the pointers are cleared (rule 3)
    await upload(url2, [ids[0]]);
    expect(await Lesson.countDocuments({ cycle: cycle._id, date: new Date("2026-10-01T00:00:00.000Z") })).toBe(1);
    const g = await admin(round._id, { action: "roundDelete", force: true });
    expect(g.body.data.round).toBeNull();
    expect(g.body.data.did).toMatchObject({ invoices: 1, requests: 1, lessons: 1 });
    expect(await InvoiceRound.countDocuments()).toBe(0);
    expect(await InvoiceRequest.countDocuments()).toBe(0);
    expect(await Invoice.countDocuments()).toBe(0);
    expect(await Lesson.countDocuments({ cycle: cycle._id, date: new Date("2026-10-01T00:00:00.000Z") })).toBe(0);
    expect((await admin(round._id, { action: "requestsSync" })).status).toBe(404);

    // rule 5: the trail
    const log = await AdminAction.find({}).sort({ at: 1, _id: 1 }).lean();
    expect(log.map((l) => l.action)).toEqual(["invoiceDelete", "requestReset", "requestReset", "sessionsRebuild", "requestsSync", "requestsSync", "requestRemove", "roundReset", "orphanSweep", "orphanSweep", "invoiceDelete", "roundDelete"]);
    expect(log[0].targets[0]).toMatchObject({ kind: "round", label: "אוקטובר 2026 · הוסטלים" });
    expect(log[0].targets[1]).toMatchObject({ kind: "invoice", label: "אביה טסט" });
    expect(log[0].did).toMatchObject({ invoices: 1, reopened: 1 });
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
