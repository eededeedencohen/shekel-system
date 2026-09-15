/**
 * תרבות לכל API — events, registrations (seats, waitlist, promotion,
 * attendance), vouchers, and the actor rules from the ERD: culture staff
 * for staff things, the student themself or staff for registrations.
 */

const request = require("supertest");
const app = require("../../../app");
const EventRegistration = require("../../../models/EventRegistration");
const {
  makeStudent, makeCultureStaff, makeCultureStudent, makeEvent, makeVoucher,
} = require("../../helpers/factories");

const reg = (event, student, by, extra = {}) =>
  request(app).post("/api/event-registrations").send({ event: event._id, student: student._id, by: by._id, ...extra });

describe("events — actors and lifecycle", () => {
  it("only culture staff may create; a draft publishes and records who did it", async () => {
    const staff = await makeCultureStaff();
    const student = await makeCultureStudent();

    const denied = await request(app).post("/api/events").send({ name: "טיול", date: "2030-05-01", by: student._id });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("NOT_CULTURE_STAFF");

    const noActor = await request(app).post("/api/events").send({ name: "טיול", date: "2030-05-01" });
    expect(noActor.body.code).toBe("NO_ACTOR");

    const created = await request(app)
      .post("/api/events")
      .send({ name: "טיול לכנרת", date: "2030-05-01T09:00:00Z", category: "trip", by: staff._id, settings: { capacity: 2 } });
    expect(created.status).toBe(201);
    expect(created.body.data.event).toMatchObject({ status: "draft", created: { by: String(staff._id) } });

    const pub = await request(app).post(`/api/events/${created.body.data.event._id}/publish`).send({ by: staff._id });
    expect(pub.body.data.event.status).toBe("published");
    expect(pub.body.data.event.published.by).toBe(String(staff._id));
  });

  it("a draft does not accept registrations (EVENT_NOT_OPEN); a cancelled event cancels its seats", async () => {
    const staff = await makeCultureStaff();
    const a = await makeCultureStudent();
    const draft = await makeEvent({ by: staff._id, status: "draft", published: null });
    const res = await reg(draft, a, staff);
    expect(res.body.code).toBe("EVENT_NOT_OPEN");

    const live = await makeEvent({ by: staff._id });
    await reg(live, a, staff);
    const cancel = await request(app).post(`/api/events/${live._id}/cancel`).send({ by: staff._id, reason: "גשם" });
    expect(cancel.body.data.cancelledRegistrations).toBe(1);
    const r = await EventRegistration.findOne({ event: live._id, student: a._id });
    expect(r.status).toBe("cancelled");
    expect(r.history.at(-1)).toMatchObject({ action: "cancelled", reason: "גשם" });
  });

  it("GET /api/events returns seat/waitlist counts per event", async () => {
    const staff = await makeCultureStaff();
    const ev = await makeEvent({ by: staff._id, settings: { capacity: 1 } });
    const [a, b] = await Promise.all([makeCultureStudent(), makeCultureStudent()]);
    await reg(ev, a, staff);
    await reg(ev, b, staff);
    const list = await request(app).get("/api/events");
    const row = list.body.data.events.find((e) => e._id === String(ev._id));
    expect(row.counts).toMatchObject({ registered: 1, waitlisted: 1 });
  });
});

describe("registrations — who, capacity, waitlist, promotion", () => {
  it("the student may register themself; a stranger may not", async () => {
    const staff = await makeCultureStaff();
    const ev = await makeEvent({ by: staff._id });
    const me = await makeCultureStudent();
    const other = await makeCultureStudent();

    const self = await reg(ev, me, me);
    expect(self.status).toBe(201);
    expect(self.body.data.registration).toMatchObject({ status: "registered", history: [{ action: "registered", by: String(me._id) }] });

    const stranger = await reg(ev, other, me); // `me` acting for `other`
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe("NOT_CULTURE_STAFF");
  });

  it("a college-only student is NOT_CULTURE_STUDENT — unless staff bring them as a GUEST", async () => {
    const staff = await makeCultureStaff();
    const ev = await makeEvent({ by: staff._id });
    const college = await makeStudent();
    const res = await reg(ev, college, staff);
    expect(res.body.code).toBe("NOT_CULTURE_STUDENT");

    // guests are a staff-only door (the senzey "אורח/ת" type)
    const selfGuest = await reg(ev, college, college, { guest: true });
    expect(selfGuest.body.code).toBe("NOT_CULTURE_STAFF");
    const asGuest = await reg(ev, college, staff, { guest: true, reason: "אמא של דנה" });
    expect(asGuest.status).toBe(201);
    expect(asGuest.body.data.registration).toMatchObject({ status: "registered", isGuest: true });
  });

  it("events carry a price and senzey import keys (unique per world)", async () => {
    const staff = await makeCultureStaff();
    const body = { by: staff._id, name: "הצגה", date: "2030-01-01T20:15:00Z", price: 240, import: { senzeyCourseId: "1624", senzeyName: "הצגה - תיאטרון ירושלים" } };
    const a = await request(app).post("/api/events").send(body);
    expect(a.status).toBe(201);
    expect(a.body.data.event.price).toBe(240);
    const dup = await request(app).post("/api/events").send(body);
    expect(dup.status).toBe(400); // duplicate senzey id → E11000 → generic duplicate message
  });

  it("duplicates are refused from every path (409 DUPLICATE_REGISTRATION)", async () => {
    const staff = await makeCultureStaff();
    const ev = await makeEvent({ by: staff._id });
    const a = await makeCultureStudent();
    await reg(ev, a, staff);
    const dup = await reg(ev, a, a);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DUPLICATE_REGISTRATION");
  });

  it("capacity → waitlist with positions; a cancellation promotes the head and renumbers", async () => {
    const staff = await makeCultureStaff();
    const ev = await makeEvent({ by: staff._id, settings: { capacity: 1 } });
    const [a, b, c] = await Promise.all([makeCultureStudent(), makeCultureStudent(), makeCultureStudent()]);
    const ra = await reg(ev, a, staff);
    const rb = await reg(ev, b, staff);
    const rc = await reg(ev, c, staff);
    expect(ra.body.data.registration.status).toBe("registered");
    expect(rb.body.data.registration).toMatchObject({ status: "waitlisted", waitlist: { position: 1, addedBy: String(staff._id) } });
    expect(rc.body.data.registration.waitlist.position).toBe(2);

    const cancel = await request(app)
      .post(`/api/event-registrations/${ra.body.data.registration._id}/cancel`)
      .send({ by: a._id, reason: "חולה" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.promoted.student).toBe(String(b._id));

    const B = await EventRegistration.findOne({ event: ev._id, student: b._id });
    const C = await EventRegistration.findOne({ event: ev._id, student: c._id });
    expect(B.status).toBe("registered");
    expect(B.history.map((h) => h.action)).toEqual(["waitlisted", "promoted"]);
    expect(C.waitlist.position).toBe(1);
  });

  it("allowWaitlist:false on a full event is EVENT_FULL", async () => {
    const staff = await makeCultureStaff();
    const ev = await makeEvent({ by: staff._id, settings: { capacity: 1 } });
    const [a, b] = await Promise.all([makeCultureStudent(), makeCultureStudent()]);
    await reg(ev, a, staff);
    const res = await reg(ev, b, staff, { allowWaitlist: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_FULL");
  });

  it("settings are enforced (gender, age) — staff may force", async () => {
    const staff = await makeCultureStaff();
    const womenOnly = await makeEvent({ by: staff._id, settings: { gender: "women", capacity: 5 } });
    const man = await makeCultureStudent({ gender: "male" });
    let res = await reg(womenOnly, man, man);
    expect(res.body.code).toBe("NOT_ELIGIBLE");
    res = await reg(womenOnly, man, man, { force: true }); // a student cannot force
    expect(res.body.code).toBe("NOT_ELIGIBLE");
    res = await reg(womenOnly, man, staff, { force: true });
    expect(res.status).toBe(201);

    const seniors = await makeEvent({ by: staff._id, settings: { ageMin: 60 } });
    const young = await makeCultureStudent({ birthDate: new Date("2000-01-01") });
    res = await reg(seniors, young, staff);
    expect(res.body.code).toBe("NOT_ELIGIBLE");
    expect(res.body.message).toContain("מתחת לגיל המינימלי");
  });

  it("a cancelled registration can register again (same document, longer history)", async () => {
    const staff = await makeCultureStaff();
    const ev = await makeEvent({ by: staff._id });
    const a = await makeCultureStudent();
    const first = await reg(ev, a, a);
    await request(app).post(`/api/event-registrations/${first.body.data.registration._id}/cancel`).send({ by: a._id });
    const again = await reg(ev, a, a);
    expect(again.status).toBe(201);
    expect(again.body.data.registration._id).toBe(first.body.data.registration._id);
    expect(again.body.data.registration.history.map((h) => h.action)).toEqual(["registered", "cancelled", "registered"]);
    expect(await EventRegistration.countDocuments({ event: ev._id })).toBe(1);
  });
});

describe("attendance", () => {
  it("staff only, registered seats only, never before the event", async () => {
    const staff = await makeCultureStaff();
    const future = await makeEvent({ by: staff._id });
    const a = await makeCultureStudent();
    const r = await reg(future, a, staff);
    const id = r.body.data.registration._id;

    let res = await request(app).patch(`/api/event-registrations/${id}/attendance`).send({ by: a._id, present: true });
    expect(res.body.code).toBe("NOT_CULTURE_STAFF");
    res = await request(app).patch(`/api/event-registrations/${id}/attendance`).send({ by: staff._id, present: true });
    expect(res.body.code).toBe("EVENT_NOT_HELD");

    // move the event to the past, then report
    await require("../../../models/Event").updateOne({ _id: future._id }, { $set: { date: new Date(Date.now() - 86400000) } });
    res = await request(app)
      .patch(`/api/event-registrations/${id}/attendance`)
      .send({ by: staff._id, present: false, note: "הודיע שלא יגיע" });
    expect(res.status).toBe(200);
    expect(res.body.data.registration.attendance).toMatchObject({ present: false, note: "הודיע שלא יגיע", reportedBy: String(staff._id) });
    expect(res.body.data.registration.history.at(-1).action).toBe("absent");

    // clearing the report
    res = await request(app).patch(`/api/event-registrations/${id}/attendance`).send({ by: staff._id, present: null });
    expect(res.body.data.registration.attendance?.present).toBeUndefined();
  });
});

describe("vouchers", () => {
  it("create (staff), grant once to a culture student, redeem once, number unique per world", async () => {
    const staff = await makeCultureStaff();
    const a = await makeCultureStudent();
    const college = await makeStudent();

    const created = await request(app)
      .post("/api/vouchers")
      .send({ by: staff._id, name: "קפה גרג", number: "G-1", initialValue: 80 });
    expect(created.status).toBe(201);
    expect(created.body.data.voucher).toMatchObject({ balance: 80, grant: null });
    const id = created.body.data.voucher._id;

    const dupNumber = await request(app).post("/api/vouchers").send({ by: staff._id, name: "קפה גרג", number: "G-1" });
    expect(dupNumber.body.code).toBe("VOUCHER_NUMBER_TAKEN");

    let res = await request(app).post(`/api/vouchers/${id}/grant`).send({ by: staff._id, student: college._id });
    expect(res.body.code).toBe("NOT_CULTURE_STUDENT");
    res = await request(app).post(`/api/vouchers/${id}/grant`).send({ by: a._id, student: a._id });
    expect(res.body.code).toBe("NOT_CULTURE_STAFF");
    res = await request(app).post(`/api/vouchers/${id}/grant`).send({ by: staff._id, student: a._id, note: "יום הולדת" });
    expect(res.status).toBe(200);
    expect(res.body.data.voucher.grant).toMatchObject({ redeemed: false, note: "יום הולדת" });
    expect(res.body.data.voucher.grant.student._id).toBe(String(a._id));

    res = await request(app).post(`/api/vouchers/${id}/grant`).send({ by: staff._id, student: a._id });
    expect(res.body.code).toBe("VOUCHER_TAKEN");

    res = await request(app).post(`/api/vouchers/${id}/redeem`).send({ by: staff._id });
    expect(res.body.data.voucher.grant.redeemed).toBe(true);
    res = await request(app).post(`/api/vouchers/${id}/redeem`).send({ by: staff._id });
    expect(res.body.code).toBe("VOUCHER_REDEEMED");

    const mine = await request(app).get(`/api/vouchers?student=${a._id}`);
    expect(mine.body.results).toBe(1);
    const stock = await request(app).get("/api/vouchers?available=true");
    expect(stock.body.results).toBe(0);
  });

  it("a granted voucher cannot be deleted; an un-redeemed grant can be revoked", async () => {
    const staff = await makeCultureStaff();
    const a = await makeCultureStudent();
    const v = await makeVoucher();
    await request(app).post(`/api/vouchers/${v._id}/grant`).send({ by: staff._id, student: a._id });
    let res = await request(app).delete(`/api/vouchers/${v._id}?by=${staff._id}`);
    expect(res.body.code).toBe("REFERENCED_BLOCKED");
    res = await request(app).post(`/api/vouchers/${v._id}/revoke`).send({ by: staff._id });
    expect(res.body.data.voucher.grant).toBeNull();
    res = await request(app).delete(`/api/vouchers/${v._id}?by=${staff._id}`);
    expect(res.status).toBe(204);
  });
});

describe("world isolation", () => {
  it("a test-world staff cannot act in the real world", async () => {
    const realStaff = await makeCultureStaff();
    const ev = await makeEvent({ by: realStaff._id });
    const a = await makeCultureStudent();
    const res = await request(app)
      .post("/api/event-registrations")
      .set("X-Dataset", "test")
      .send({ event: ev._id, student: a._id, by: realStaff._id });
    expect(res.body.code).toBe("WORLD_MISMATCH");
  });
});
