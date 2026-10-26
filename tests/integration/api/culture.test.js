/**
 * תרבות לכל API - events, registrations (seats, waitlist, promotion,
 * attendance), vouchers, and the actor rules: since 2026-10-26 the actor
 * is the SESSION (utils/actor) - a culture-staff account (super / social /
 * culture) for staff things, never a person id from the body; a manager's
 * or hostels account never reaches the culture family at all (the gate
 * answers OUT_OF_SCOPE). The record remembers the account's Person row
 * when the account is linked to one, and its name always.
 */

const request = require("supertest");
const app = require("../../../app");
const EventRegistration = require("../../../models/EventRegistration");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const {
  makeStudent, makeCultureStaff, makeCultureStudent, makeEvent, makeVoucher,
} = require("../../helpers/factories");

/** The signed-in account of the test bypass: its kind and the Person row it is linked to. */
const actAs = ({ person = null, kind = "super" } = {}) => {
  TEST_ACCOUNT.person = person;
  TEST_ACCOUNT.kind = kind;
};
/** A culture coordinator signed in: her own Person row (ManagerCulture) linked to the account. */
const staffIn = async () => {
  const staff = await makeCultureStaff();
  actAs({ person: staff._id, kind: "culture" });
  return staff;
};
afterEach(() => actAs());

const reg = (event, student, extra = {}) =>
  request(app).post("/api/event-registrations").send({ event: event._id, student: student._id, ...extra });

describe("events - actors and lifecycle", () => {
  it("only culture staff may create; the body's `by` is ignored; a draft publishes and records who did it", async () => {
    const student = await makeCultureStudent();

    // a college manager's account: the family gate, before any service
    actAs({ kind: "manager" });
    const denied = await request(app).post("/api/events").send({ name: "טיול", date: "2030-05-01" });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("OUT_OF_SCOPE");

    // the coordinator - whatever the body says about `by`
    const staff = await staffIn();
    const created = await request(app)
      .post("/api/events")
      .send({ name: "טיול לכנרת", date: "2030-05-01T09:00:00Z", category: "trip", by: student._id, settings: { capacity: 2 } });
    expect(created.status).toBe(201);
    expect(created.body.data.event).toMatchObject({ status: "draft", created: { by: String(staff._id), byName: "בדיקות" } });

    const pub = await request(app).post(`/api/events/${created.body.data.event._id}/publish`).send({});
    expect(pub.body.data.event.status).toBe("published");
    expect(pub.body.data.event.published).toMatchObject({ by: String(staff._id), byName: "בדיקות" });

    // an account with no Person row (the super admin) leaves its name alone
    actAs();
    const bySuper = await request(app).post("/api/events").send({ name: "ערב שירה", date: "2030-06-01T19:00:00Z" });
    expect(bySuper.status).toBe(201);
    expect(bySuper.body.data.event.created.by).toBeUndefined();
    expect(bySuper.body.data.event.created.byName).toBe("בדיקות");
  });

  it("a draft does not accept registrations (EVENT_NOT_OPEN); a cancelled event cancels its seats", async () => {
    const staff = await staffIn();
    const a = await makeCultureStudent();
    const draft = await makeEvent({ by: staff._id, status: "draft", published: null });
    const res = await reg(draft, a);
    expect(res.body.code).toBe("EVENT_NOT_OPEN");

    const live = await makeEvent({ by: staff._id });
    await reg(live, a);
    const cancel = await request(app).post(`/api/events/${live._id}/cancel`).send({ reason: "גשם" });
    expect(cancel.body.data.cancelledRegistrations).toBe(1);
    const r = await EventRegistration.findOne({ event: live._id, student: a._id });
    expect(r.status).toBe("cancelled");
    expect(r.history.at(-1)).toMatchObject({ action: "cancelled", reason: "גשם", byName: "בדיקות" });
  });

  it("only a draft deletes; a published event (even an empty one) is cancelled instead", async () => {
    const staff = await staffIn();
    const draft = await makeEvent({ by: staff._id, status: "draft", published: null });
    const del = await request(app).delete(`/api/events/${draft._id}`);
    expect(del.status).toBe(204);

    const live = await makeEvent({ by: staff._id }); // published, nobody registered
    const refused = await request(app).delete(`/api/events/${live._id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("EVENT_NOT_DRAFT");
  });

  it("GET /api/events returns seat/waitlist counts per event", async () => {
    const staff = await staffIn();
    const ev = await makeEvent({ by: staff._id, settings: { capacity: 1 } });
    const [a, b] = await Promise.all([makeCultureStudent(), makeCultureStudent()]);
    await reg(ev, a);
    await reg(ev, b);
    const list = await request(app).get("/api/events");
    const row = list.body.data.events.find((e) => e._id === String(ev._id));
    expect(row.counts).toMatchObject({ registered: 1, waitlisted: 1 });
  });
});

describe("registrations - who, capacity, waitlist, promotion", () => {
  it("staff register; the history names the account's person; a hostels account is outside the family", async () => {
    const staff = await staffIn();
    const ev = await makeEvent({ by: staff._id });
    const me = await makeCultureStudent();
    const other = await makeCultureStudent();

    const first = await reg(ev, me);
    expect(first.status).toBe(201);
    expect(first.body.data.registration).toMatchObject({ status: "registered", history: [{ action: "registered", by: String(staff._id), byName: "בדיקות" }] });

    actAs({ kind: "hostels" });
    const stranger = await reg(ev, other);
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe("OUT_OF_SCOPE");
  });

  it("a college-only student is NOT_CULTURE_STUDENT - unless staff bring them as a GUEST", async () => {
    const staff = await staffIn();
    const ev = await makeEvent({ by: staff._id });
    const college = await makeStudent();
    const res = await reg(ev, college);
    expect(res.body.code).toBe("NOT_CULTURE_STUDENT");

    // guests are a staff-only door (the senzey "אורח/ת" type)
    const asGuest = await reg(ev, college, { guest: true, reason: "אמא של דנה" });
    expect(asGuest.status).toBe(201);
    expect(asGuest.body.data.registration).toMatchObject({ status: "registered", isGuest: true });
  });

  it("events carry a price and senzey import keys (unique)", async () => {
    await staffIn();
    const body = { name: "הצגה", date: "2030-01-01T20:15:00Z", price: 240, import: { senzeyCourseId: "1624", senzeyName: "הצגה - תיאטרון ירושלים" } };
    const a = await request(app).post("/api/events").send(body);
    expect(a.status).toBe(201);
    expect(a.body.data.event.price).toBe(240);
    const dup = await request(app).post("/api/events").send(body);
    expect(dup.status).toBe(400); // duplicate senzey id → E11000 → generic duplicate message
  });

  it("duplicates are refused from every path (409 DUPLICATE_REGISTRATION)", async () => {
    const staff = await staffIn();
    const ev = await makeEvent({ by: staff._id });
    const a = await makeCultureStudent();
    await reg(ev, a);
    const dup = await reg(ev, a);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DUPLICATE_REGISTRATION");
  });

  it("capacity → waitlist with positions; a cancellation promotes the head and renumbers", async () => {
    const staff = await staffIn();
    const ev = await makeEvent({ by: staff._id, settings: { capacity: 1 } });
    const [a, b, c] = await Promise.all([makeCultureStudent(), makeCultureStudent(), makeCultureStudent()]);
    const ra = await reg(ev, a);
    const rb = await reg(ev, b);
    const rc = await reg(ev, c);
    expect(ra.body.data.registration.status).toBe("registered");
    expect(rb.body.data.registration).toMatchObject({ status: "waitlisted", waitlist: { position: 1, addedBy: String(staff._id), addedByName: "בדיקות" } });
    expect(rc.body.data.registration.waitlist.position).toBe(2);

    const cancel = await request(app)
      .post(`/api/event-registrations/${ra.body.data.registration._id}/cancel`)
      .send({ reason: "חולה" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.promoted.student).toBe(String(b._id));

    const B = await EventRegistration.findOne({ event: ev._id, student: b._id });
    const C = await EventRegistration.findOne({ event: ev._id, student: c._id });
    expect(B.status).toBe("registered");
    expect(B.history.map((h) => h.action)).toEqual(["waitlisted", "promoted"]);
    expect(C.waitlist.position).toBe(1);
  });

  it("allowWaitlist:false on a full event is EVENT_FULL", async () => {
    const staff = await staffIn();
    const ev = await makeEvent({ by: staff._id, settings: { capacity: 1 } });
    const [a, b] = await Promise.all([makeCultureStudent(), makeCultureStudent()]);
    await reg(ev, a);
    const res = await reg(ev, b, { allowWaitlist: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_FULL");
  });

  it("settings are enforced (gender, age) - staff may force", async () => {
    const staff = await staffIn();
    const womenOnly = await makeEvent({ by: staff._id, settings: { gender: "women", capacity: 5 } });
    const man = await makeCultureStudent({ gender: "male" });
    let res = await reg(womenOnly, man);
    expect(res.body.code).toBe("NOT_ELIGIBLE");
    res = await reg(womenOnly, man, { force: true });
    expect(res.status).toBe(201);

    const seniors = await makeEvent({ by: staff._id, settings: { ageMin: 60 } });
    const young = await makeCultureStudent({ birthDate: new Date("2000-01-01") });
    res = await reg(seniors, young);
    expect(res.body.code).toBe("NOT_ELIGIBLE");
    expect(res.body.message).toContain("מתחת לגיל המינימלי");
  });

  it("a cancelled registration can register again (same document, longer history)", async () => {
    const staff = await staffIn();
    const ev = await makeEvent({ by: staff._id });
    const a = await makeCultureStudent();
    const first = await reg(ev, a);
    await request(app).post(`/api/event-registrations/${first.body.data.registration._id}/cancel`).send({});
    const again = await reg(ev, a);
    expect(again.status).toBe(201);
    expect(again.body.data.registration._id).toBe(first.body.data.registration._id);
    expect(again.body.data.registration.history.map((h) => h.action)).toEqual(["registered", "cancelled", "registered"]);
    expect(await EventRegistration.countDocuments({ event: ev._id })).toBe(1);
  });
});

describe("attendance", () => {
  it("staff only, registered seats only, never before the event", async () => {
    const staff = await staffIn();
    const future = await makeEvent({ by: staff._id });
    const a = await makeCultureStudent();
    const r = await reg(future, a);
    const id = r.body.data.registration._id;

    actAs({ kind: "manager" });
    let res = await request(app).patch(`/api/event-registrations/${id}/attendance`).send({ present: true });
    expect(res.body.code).toBe("OUT_OF_SCOPE");
    actAs({ person: staff._id, kind: "culture" });
    res = await request(app).patch(`/api/event-registrations/${id}/attendance`).send({ present: true });
    expect(res.body.code).toBe("EVENT_NOT_HELD");

    // move the event to the past, then report
    await require("../../../models/Event").updateOne({ _id: future._id }, { $set: { date: new Date(Date.now() - 86400000) } });
    res = await request(app)
      .patch(`/api/event-registrations/${id}/attendance`)
      .send({ present: false, note: "הודיע שלא יגיע" });
    expect(res.status).toBe(200);
    expect(res.body.data.registration.attendance).toMatchObject({ present: false, note: "הודיע שלא יגיע", reportedBy: String(staff._id), reportedByName: "בדיקות" });
    expect(res.body.data.registration.history.at(-1).action).toBe("absent");

    // clearing the report
    res = await request(app).patch(`/api/event-registrations/${id}/attendance`).send({ present: null });
    expect(res.body.data.registration.attendance?.present).toBeUndefined();
  });
});

describe("vouchers", () => {
  it("create (staff), grant once to a culture student, redeem once, number unique", async () => {
    const staff = await staffIn();
    const a = await makeCultureStudent();
    const college = await makeStudent();

    const created = await request(app)
      .post("/api/vouchers")
      .send({ name: "קפה גרג", number: "G-1", initialValue: 80 });
    expect(created.status).toBe(201);
    expect(created.body.data.voucher).toMatchObject({ balance: 80, grant: null });
    const id = created.body.data.voucher._id;

    const dupNumber = await request(app).post("/api/vouchers").send({ name: "קפה גרג", number: "G-1" });
    expect(dupNumber.body.code).toBe("VOUCHER_NUMBER_TAKEN");

    let res = await request(app).post(`/api/vouchers/${id}/grant`).send({ student: college._id });
    expect(res.body.code).toBe("NOT_CULTURE_STUDENT");
    actAs({ kind: "manager" });
    res = await request(app).post(`/api/vouchers/${id}/grant`).send({ student: a._id });
    expect(res.body.code).toBe("OUT_OF_SCOPE");
    actAs({ person: staff._id, kind: "culture" });
    res = await request(app).post(`/api/vouchers/${id}/grant`).send({ student: a._id, note: "יום הולדת" });
    expect(res.status).toBe(200);
    expect(res.body.data.voucher.grant).toMatchObject({ redeemed: false, note: "יום הולדת", byName: "בדיקות" });
    expect(res.body.data.voucher.grant.student._id).toBe(String(a._id));
    expect(res.body.data.voucher.grant.by._id).toBe(String(staff._id));

    res = await request(app).post(`/api/vouchers/${id}/grant`).send({ student: a._id });
    expect(res.body.code).toBe("VOUCHER_TAKEN");

    res = await request(app).post(`/api/vouchers/${id}/redeem`).send({});
    expect(res.body.data.voucher.grant.redeemed).toBe(true);
    res = await request(app).post(`/api/vouchers/${id}/redeem`).send({});
    expect(res.body.code).toBe("VOUCHER_REDEEMED");

    const mine = await request(app).get(`/api/vouchers?student=${a._id}`);
    expect(mine.body.results).toBe(1);
    const stock = await request(app).get("/api/vouchers?available=true");
    expect(stock.body.results).toBe(0);
  });

  it("a granted voucher cannot be deleted; an un-redeemed grant can be revoked", async () => {
    await staffIn();
    const a = await makeCultureStudent();
    const v = await makeVoucher();
    await request(app).post(`/api/vouchers/${v._id}/grant`).send({ student: a._id });
    let res = await request(app).delete(`/api/vouchers/${v._id}`);
    expect(res.body.code).toBe("REFERENCED_BLOCKED");
    res = await request(app).post(`/api/vouchers/${v._id}/revoke`).send({});
    expect(res.body.data.voucher.grant).toBeNull();
    res = await request(app).delete(`/api/vouchers/${v._id}`);
    expect(res.status).toBe(204);
  });
});

describe("voucher pictures", () => {
  const images = require("../../../services/voucherImageService");
  const StoredFile = require("../../../models/StoredFile");
  const bucket = require("../../helpers/bucket");
  // a 1×1 PNG
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const pngBytes = Buffer.from(PNG.split(",")[1], "base64");
  afterEach(() => images.setFetch(null));

  it("an upload is stored once per place: the next voucher of the place reuses it, the file goes with the last voucher", async () => {
    const staff = await makeCultureStaff();
    const first = await request(app).post("/api/vouchers").send({ by: staff._id, name: "סינמה סיטי", number: "P-1", imageData: PNG, imageThumb: PNG, imageName: "logo.png" });
    expect(first.status).toBe(201);
    const fileId = first.body.data.voucher.image;
    expect(fileId).toBeTruthy();
    expect(await StoredFile.countDocuments()).toBe(1);

    // the picture's plain links answer with a signed read of the bucket, small or full
    const thumb = await request(app).get(`/api/vouchers/${first.body.data.voucher._id}/image?thumb=1`);
    expect(bucket.keyOf(thumb)).toMatch(/^culture\/.*\.thumb\.jpg$/);
    expect(bucket.mimeOf(thumb)).toBe("image/jpeg");
    const full = await request(app).get(`/api/vouchers/${first.body.data.voucher._id}/image`);
    expect(bucket.mimeOf(full)).toBe("image/png");
    expect(Buffer.compare(await bucket.bytesOf(full), pngBytes)).toBe(0);
    expect(full.headers["cache-control"]).toBe("private, no-store");

    // the second voucher of the place: the same file, no new upload
    const second = await request(app).post("/api/vouchers").send({ by: staff._id, name: "סינמה סיטי", number: "P-2", imageFrom: first.body.data.voucher._id });
    expect(second.status).toBe(201);
    expect(second.body.data.voucher.image).toBe(fileId);
    expect(await StoredFile.countDocuments()).toBe(1);

    // deleting one keeps the shared file; deleting the last removes it
    expect((await request(app).delete(`/api/vouchers/${first.body.data.voucher._id}?by=${staff._id}`)).status).toBe(204);
    expect(await StoredFile.countDocuments()).toBe(1);
    expect((await request(app).delete(`/api/vouchers/${second.body.data.voucher._id}?by=${staff._id}`)).status).toBe(204);
    expect(await StoredFile.countDocuments()).toBe(0);
  });

  it("set, replace and remove the picture of an existing voucher; a bad upload is refused", async () => {
    const staff = await makeCultureStaff();
    const v = await makeVoucher();
    let res = await request(app).patch(`/api/vouchers/${v._id}/image`).send({ by: staff._id, imageData: PNG });
    expect(res.status).toBe(200);
    const firstFile = res.body.data.voucher.image;
    res = await request(app).patch(`/api/vouchers/${v._id}/image`).send({ by: staff._id, imageData: PNG });
    expect(res.body.data.voucher.image).not.toBe(firstFile);
    expect(await StoredFile.countDocuments()).toBe(1); // the replaced file is gone
    res = await request(app).patch(`/api/vouchers/${v._id}/image`).send({ by: staff._id, imageData: "data:text/plain;base64,aGk=" });
    expect(res.body.code).toBe("VOUCHER_IMAGE_INVALID");
    res = await request(app).patch(`/api/vouchers/${v._id}/image`).send({ by: staff._id, remove: true });
    expect(res.body.data.voucher.image).toBeNull();
    expect(await StoredFile.countDocuments()).toBe(0);
    expect((await request(app).get(`/api/vouchers/${v._id}/image`)).status).toBe(404);
  });

  it("a link on the web: a picture's address, or a page whose og:image is the picture; the search asks Wikipedia", async () => {
    const staff = await makeCultureStaff();
    const page = `<html><head><meta property="og:image" content="/pics/front.png" /></head></html>`;
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    const found = { query: { search: [{ title: "קפה גרג" }, { title: "גרג" }] } };
    const pages = { query: { pages: { 1: { title: "קפה גרג", fullurl: "https://he.wikipedia.org/wiki/x", thumbnail: { source: "https://upload.wikimedia.org/greg-front.jpg", width: 600, height: 400 } }, 2: { title: "גרג" } } } };
    const article = { parse: { text: { "*": `<div><table class="infobox"><tr><td><img src="//thumb.wikimedia.org/wikipedia/he/thumb/6/63/greg.png/250px-greg.png?utm_source=x" /></td></tr></table></div>` } } };
    images.setFetch(async (url) => {
      if (url.includes("list=search")) return json(found);
      if (url.includes("prop=pageimages")) return json(pages);
      if (url.includes("action=parse")) return json(url.includes(encodeURIComponent("קפה גרג")) ? article : { parse: { text: { "*": "<p>no box</p>" } } });
      if (url === "https://example.test/cafe") return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      if (url === "https://example.test/pics/front.png" || url === "https://upload.wikimedia.org/greg.png") return new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } });
      return new Response("no", { status: 404 });
    });
    const res = await request(app).get("/api/vouchers/image-search?q=קפה גרג");
    expect(res.status).toBe(200);
    // the logo (the infobox picture, made absolute, untracked) first, the photo after it
    expect(res.body.data.images).toEqual([
      expect.objectContaining({ title: "קפה גרג", kind: "logo", url: "https://thumb.wikimedia.org/wikipedia/he/thumb/6/63/greg.png/250px-greg.png", source: "ויקיפדיה" }),
      expect.objectContaining({ title: "קפה גרג", kind: "photo", url: "https://upload.wikimedia.org/greg-front.jpg" }),
    ]);

    const fromPage = await request(app).post("/api/vouchers").send({ by: staff._id, name: "קפה גרג", number: "L-1", imageUrl: "https://example.test/cafe" });
    expect(fromPage.status).toBe(201);
    expect(fromPage.body.data.voucher.image).toBeTruthy();
    const fromPicture = await request(app).post("/api/vouchers").send({ by: staff._id, name: "קפה גרג", number: "L-2", imageUrl: "https://upload.wikimedia.org/greg.png" });
    expect(fromPicture.status).toBe(201);
    const dead = await request(app).post("/api/vouchers").send({ by: staff._id, name: "קפה גרג", number: "L-3", imageUrl: "https://example.test/nothing" });
    expect(dead.body.code).toBe("VOUCHER_IMAGE_FETCH");
    expect(await StoredFile.countDocuments()).toBe(2);

    // the browser squares every picture itself, so it asks the server for the bytes of a web picture
    const bytes = await request(app).get("/api/vouchers/image-fetch").query({ url: "https://upload.wikimedia.org/greg.png" });
    expect(bytes.status).toBe(200);
    expect(bytes.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.compare(bytes.body, pngBytes)).toBe(0);
    const viaPage = await request(app).get("/api/vouchers/image-fetch").query({ url: "https://example.test/cafe" });
    expect(viaPage.status).toBe(200);
    expect(viaPage.headers["content-type"]).toMatch(/image\/png/);
    expect((await request(app).get("/api/vouchers/image-fetch").query({ url: "https://example.test/nothing" })).body.code).toBe("VOUCHER_IMAGE_FETCH");
    expect((await request(app).get("/api/vouchers/image-fetch").query({ url: "ftp://x" })).status).toBe(422);
  });
});
