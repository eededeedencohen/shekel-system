/**
 * @file The activity pages (Eden, 2026-10-29): the sign-ins, who is online, every write written down
 *
 * AUTH_ENFORCE=1 - real sign-ins, so the audit has an account to name.
 */

const request = require("supertest");
const app = require("../../../app");
const StaffAccount = require("../../../models/StaffAccount");
const StaffLogin = require("../../../models/StaffLogin");
const AuditEvent = require("../../../models/AuditEvent");
const { ensureSeedAccounts } = require("../../../services/authService");
const presence = require("../../../services/presenceService");
const { flush } = require("../../../utils/audit");
const { normalizeRoute, ruleFor, sanitizePayload, describe: describeWrite } = require("../../../utils/auditDescribe");
const { describeUserAgent } = require("../../../utils/userAgent");
const { defaultPasswordFor } = require("../../../utils/password");

beforeAll(() => {
  process.env.AUTH_ENFORCE = "1";
});
afterAll(() => {
  delete process.env.AUTH_ENFORCE;
});

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const signIn = async (username, ua = PC_UA, password = defaultPasswordFor(username)) => {
  const res = await request(app).post("/api/auth/login").set("User-Agent", ua).send({ username, password });
  return { res, cookie: cookieOf(res) };
};
const idOf = async (username) => String((await StaffAccount.findOne({ username }).lean())._id);

describe("the sign-ins (StaffLogin)", () => {
  beforeEach(async () => {
    await ensureSeedAccounts();
    presence.reset();
  });

  test("a sign-in opens a row with the device and the address; signing out ends it as 'logout'", async () => {
    const { cookie } = await signIn("tamar", PHONE_UA);
    const tamar = await idOf("tamar");
    let rows = await StaffLogin.find({ account: tamar }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ how: "password", endedAt: null, device: { browser: "Safari", os: "iPhone", mobile: true } });
    expect(rows[0].ip).toBeTruthy();
    await request(app).post("/api/auth/logout").set("Cookie", cookie).expect(200);
    rows = await StaffLogin.find({ account: tamar }).lean();
    expect(rows[0].endReason).toBe("logout");
    expect(rows[0].endedAt).toBeTruthy();
    // the sign-ins page sees it ended, not live
    const { cookie: eden } = await signIn("eden");
    const list = await request(app).get(`/api/audit/logins?account=${tamar}`).set("Cookie", eden);
    expect(list.status).toBe(200);
    expect(list.body.data.logins).toHaveLength(1);
    expect(list.body.data.logins[0]).toMatchObject({ live: false, endReason: "logout", state: "ended", account: { username: "tamar", name: "תמר צימרינג" } });
  });

  test("a new password ends the other browsers' sign-ins as 'password'; disabling the account as 'disabled'", async () => {
    const { cookie: a } = await signIn("noa");
    await signIn("noa", PHONE_UA);
    await request(app).post("/api/auth/password").set("Cookie", a).send({ current: defaultPasswordFor("noa"), next: "noa-pass-2026" }).expect(200);
    const noa = await idOf("noa");
    const rows = await StaffLogin.find({ account: noa }).sort({ startedAt: 1 }).lean();
    expect(rows.map((r) => r.endReason)).toEqual([null, "password"]);
    const { cookie: eden } = await signIn("eden");
    await request(app).patch(`/api/accounts/${noa}`).set("Cookie", eden).send({ active: false }).expect(200);
    const after = await StaffLogin.find({ account: noa }).sort({ startedAt: 1 }).lean();
    expect(after.map((r) => r.endReason)).toEqual(["disabled", "password"]);
  });

  test("behind Cloudflare the row records the person's address, not the edge's", async () => {
    const res = await request(app).post("/api/auth/login").set("User-Agent", PC_UA).set("CF-Connecting-IP", "84.95.1.2").send({ username: "hagai", password: defaultPasswordFor("hagai") });
    expect(res.status).toBe(200);
    const row = await StaffLogin.findOne({ account: await idOf("hagai") }).lean();
    expect(row.ip).toBe("84.95.1.2");
    await request(app).post("/api/rooms").set("Cookie", cookieOf(res)).set("X-Forwarded-For", "84.95.1.3, 172.69.1.1").send({ name: "חדר מרחוק" }).expect(201);
    await flush();
    expect((await AuditEvent.findOne().lean()).ip).toBe("84.95.1.3");
  });

  test("a sign-in not seen for a month is read and written as expired", async () => {
    await signIn("hagai");
    const hagai = await idOf("hagai");
    const old = new Date(Date.now() - 40 * 86400000);
    await StaffLogin.updateMany({ account: hagai }, { startedAt: old, lastSeenAt: old });
    const { cookie: eden } = await signIn("eden");
    const list = await request(app).get(`/api/audit/logins?account=${hagai}`).set("Cookie", eden);
    expect(list.body.data.logins[0]).toMatchObject({ live: false, endReason: "expired" });
    expect(new Date(list.body.data.logins[0].endedAt).getTime()).toBe(old.getTime() + 30 * 86400000);
    expect((await StaffLogin.findOne({ account: hagai }).lean()).endReason).toBe("expired");
  });

  test("the list pages with `before`, newest first, with the account on every row", async () => {
    await signIn("hagai");
    await signIn("noa");
    await signIn("yetav");
    const { cookie: eden } = await signIn("eden");
    const page1 = await request(app).get("/api/audit/logins?limit=2").set("Cookie", eden);
    expect(page1.body.data.logins.map((l) => l.account.username)).toEqual(["eden", "yetav"]);
    expect(page1.body.data.hasMore).toBe(true);
    const page2 = await request(app).get(`/api/audit/logins?limit=2&before=${encodeURIComponent(page1.body.data.logins[1].startedAt)}`).set("Cookie", eden);
    expect(page2.body.data.logins.map((l) => l.account.username)).toEqual(["noa", "hagai"]);
    expect(page2.body.data.hasMore).toBe(false);
  });
});

describe("who is online (presence)", () => {
  beforeEach(async () => {
    await ensureSeedAccounts();
    presence.reset();
  });

  test("a request or a ping makes the account 'active'; signing out takes it off; an idle one is 'idle'", async () => {
    const { cookie: shiran } = await signIn("shiran", PHONE_UA);
    await request(app).post("/api/auth/ping").set("Cookie", shiran).expect(204);
    const { cookie: eden } = await signIn("eden");
    let res = await request(app).get("/api/audit/presence").set("Cookie", eden);
    expect(res.status).toBe(200);
    const names = res.body.data.online.map((o) => o.account.username).sort();
    expect(names).toEqual(["eden", "shiran"]);
    expect(res.body.data.online.find((o) => o.account.username === "shiran")).toMatchObject({ state: "active", device: { os: "iPhone" } });
    // seen ten minutes ago: idle
    const shiranId = await idOf("shiran");
    presence.reset();
    await StaffLogin.updateMany({ account: shiranId }, { lastSeenAt: new Date(Date.now() - 10 * 60000) });
    res = await request(app).get("/api/audit/presence").set("Cookie", eden);
    expect(res.body.data.online.find((o) => o.account.username === "shiran").state).toBe("idle");
    // signed out: gone
    await request(app).post("/api/auth/logout").set("Cookie", shiran).expect(200);
    res = await request(app).get("/api/audit/presence").set("Cookie", eden);
    expect(res.body.data.online.map((o) => o.account.username)).toEqual(["eden"]);
  });

  test("the overview: every account with its state, sign-ins and writes summed up", async () => {
    const { cookie: hagai } = await signIn("hagai");
    await request(app).post("/api/rooms").set("Cookie", hagai).send({ name: "חדר לסיכום" }).expect(201);
    await flush();
    const { cookie: eden } = await signIn("eden");
    const res = await request(app).get("/api/audit/overview").set("Cookie", eden);
    expect(res.status).toBe(200);
    expect(res.body.data.accounts).toHaveLength(6);
    const h = res.body.data.accounts.find((a) => a.username === "hagai");
    expect(h).toMatchObject({ state: "active", logins: 1, openLogins: 1, actions30d: 1, sessions: 1 });
    expect(h.lastActionAt).toBeTruthy();
    const t = res.body.data.accounts.find((a) => a.username === "tamar");
    expect(t).toMatchObject({ state: "offline", logins: 0, actions30d: 0 });
    expect(res.body.data.online.map((o) => o.account.username).sort()).toEqual(["eden", "hagai"]);
  });
});

describe("every write written down (AuditEvent)", () => {
  beforeEach(async () => {
    await ensureSeedAccounts();
    presence.reset();
  });

  test("a POST is one event with the Hebrew title, the verb, the kind, the target's name and the payload; reads and refusals are none", async () => {
    const { cookie } = await signIn("hagai");
    const made = await request(app).post("/api/rooms").set("Cookie", cookie).send({ name: "חדר מוזיקה", capacity: 12 });
    expect(made.status).toBe(201);
    await request(app).get("/api/rooms").set("Cookie", cookie).expect(200);
    await request(app).post("/api/rooms").set("Cookie", cookie).send({}).expect(400); // no name
    await flush();
    const events = await AuditEvent.find().lean();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e).toMatchObject({
      method: "POST",
      path: "/rooms",
      route: "/rooms",
      status: 201,
      verb: "create",
      title: "חדר חדש",
      kind: "room",
      actorName: "חגי",
      accountName: "חגי",
      actorKind: "manager",
      payload: { name: "חדר מוזיקה", capacity: 12 },
    });
    expect(e.target).toMatchObject({ id: made.body.data.room._id, label: "חדר מוזיקה" });
    expect(String(e.account)).toBe(await idOf("hagai"));
    expect(String(e.actor)).toBe(await idOf("hagai"));
    expect(e.session).toBeTruthy();
    // the sign-in row counts it
    expect((await StaffLogin.findOne({ session: e.session }).lean()).actions).toBe(1);
  });

  test("an edit and a delete fold the id into the route and name what was touched", async () => {
    const { cookie } = await signIn("hagai");
    const made = await request(app).post("/api/rooms").set("Cookie", cookie).send({ name: "חדר ישן" });
    const id = made.body.data.room._id;
    await request(app).put(`/api/rooms/${id}`).set("Cookie", cookie).send({ name: "חדר חדש יותר" }).expect(200);
    await request(app).delete(`/api/rooms/${id}`).set("Cookie", cookie).expect(204);
    await flush();
    const events = await AuditEvent.find().sort({ at: 1, _id: 1 }).lean();
    expect(events.map((e) => [e.verb, e.title, e.route])).toEqual([
      ["create", "חדר חדש", "/rooms"],
      ["update", "עריכת חדר", "/rooms/:id"],
      ["delete", "מחיקת חדר", "/rooms/:id"],
    ]);
    expect(events[1].target).toMatchObject({ id, label: "חדר חדש יותר" });
    expect(events[2].target.id).toBe(id);
    expect(events[2].path).toBe(`/rooms/${id}`);
  });

  test("viewing as someone: the account is the super admin, the actor the borrowed one; both pages show it", async () => {
    const { cookie: eden } = await signIn("eden");
    const hagai = await idOf("hagai");
    const edenId = await idOf("eden");
    await request(app).post("/api/rooms").set("Cookie", eden).set("X-Acting-As", hagai).send({ name: "חדר בצפייה" }).expect(201);
    await flush();
    const e = await AuditEvent.findOne().lean();
    expect(String(e.account)).toBe(edenId);
    expect(String(e.actor)).toBe(hagai);
    expect(e.actorName).toBe("חגי");
    expect(e.accountName).toBe("עדן כהן");
    for (const user of [hagai, edenId]) {
      const res = await request(app).get(`/api/audit/events?user=${user}`).set("Cookie", eden);
      expect(res.body.data.events).toHaveLength(1);
      expect(res.body.data.events[0]).toMatchObject({ borrowed: true, title: "חדר חדש" });
    }
  });

  test("passwords and tokens never reach the log; the doors themselves are not events", async () => {
    const { cookie } = await signIn("noa");
    await request(app).post("/api/auth/password").set("Cookie", cookie).send({ current: defaultPasswordFor("noa"), next: "noa-pass-2026" }).expect(200);
    const { cookie: eden } = await signIn("eden");
    const shiran = await idOf("shiran");
    await request(app).post(`/api/accounts/${shiran}/reset`).set("Cookie", eden).send({ token: "A".repeat(20) + "b_c-" + "9".repeat(20) }).expect(201);
    await request(app).patch(`/api/accounts/${shiran}`).set("Cookie", eden).send({ title: "רכזת" }).expect(200);
    await request(app).post("/api/auth/ping").set("Cookie", eden).expect(204);
    await request(app).post("/api/auth/logout").set("Cookie", cookie).expect(200);
    await flush();
    const events = await AuditEvent.find().sort({ at: 1, _id: 1 }).lean();
    expect(events.map((e) => e.title)).toEqual(["שינוי הסיסמה שלי", "קישור לאיפוס סיסמה", "עריכת משתמש"]);
    expect(events[0].payload).toBeNull();
    expect(events[1].payload).toBeNull();
    expect(events[2].payload).toEqual({ title: "רכזת" });
    expect(events[2].target).toMatchObject({ id: shiran, label: "שירן דרעי" });
    expect(JSON.stringify(events)).not.toMatch(/noa-pass-2026|AAAAAAAA/);
  });

  test("the events list filters by verb, kind and text, pages with `before`, and is the super admin's alone", async () => {
    const { cookie: hagai } = await signIn("hagai");
    for (const name of ["אלף", "בית", "גימל"]) await request(app).post("/api/rooms").set("Cookie", hagai).send({ name });
    const rooms = (await request(app).get("/api/rooms").set("Cookie", hagai)).body.data.rooms;
    await request(app).put(`/api/rooms/${rooms[0]._id}`).set("Cookie", hagai).send({ name: "אלף ב" }).expect(200);
    await flush();
    const { cookie: eden } = await signIn("eden");
    const all = await request(app).get("/api/audit/events").set("Cookie", eden);
    expect(all.body.data.events).toHaveLength(4);
    expect(all.body.data.events[0].title).toBe("עריכת חדר"); // newest first
    expect((await request(app).get("/api/audit/events?verb=update").set("Cookie", eden)).body.data.events).toHaveLength(1);
    expect((await request(app).get("/api/audit/events?kind=room&verb=create").set("Cookie", eden)).body.data.events).toHaveLength(3);
    expect((await request(app).get("/api/audit/events?q=גימל").set("Cookie", eden)).body.data.events.map((e) => e.target.label)).toEqual(["גימל"]);
    const page1 = await request(app).get("/api/audit/events?limit=3").set("Cookie", eden);
    expect(page1.body.data.hasMore).toBe(true);
    const page2 = await request(app).get(`/api/audit/events?limit=3&before=${encodeURIComponent(page1.body.data.events[2].at)}`).set("Cookie", eden);
    expect(page2.body.data.events.map((e) => e.target.label)).toEqual(["אלף"]);
    // the user's header
    const hagaiId = await idOf("hagai");
    const head = await request(app).get(`/api/audit/users/${hagaiId}`).set("Cookie", eden);
    expect(head.body.data).toMatchObject({ account: { username: "hagai" }, actions: { total: 4, create: 3, update: 1, delete: 0 }, logins: { total: 1, open: 1 }, state: "active" });
    expect((await request(app).get("/api/audit/users/000000000000000000000000").set("Cookie", eden)).status).toBe(404);
    // closed to everyone else - and to the super admin viewing as someone
    for (const path of ["/api/audit/overview", "/api/audit/presence", "/api/audit/logins", "/api/audit/events", `/api/audit/users/${hagaiId}`]) {
      expect((await request(app).get(path).set("Cookie", hagai)).status).toBe(403);
      expect((await request(app).get(path).set("Cookie", eden).set("X-Acting-As", hagaiId)).status).toBe(403);
    }
  });
});

describe("in words (utils/auditDetails) and the clearing", () => {
  const { makeStudent, makeTeacher, makeCycle } = require("../../helpers/factories");

  beforeEach(async () => {
    await ensureSeedAccounts();
    presence.reset();
  });

  test("attendance: the course by name, the date in Hebrew, every student by name with the status", async () => {
    const teacher = await makeTeacher({ firstName: "אלישבע", lastName: "כהן" });
    const cycle = await makeCycle({ teacher: teacher._id });
    const a = await makeStudent({ firstName: "דנה", lastName: "לוי" });
    const b = await makeStudent({ firstName: "יוסי", lastName: "מזרחי" });
    const { cookie } = await signIn("hagai");
    const res = await request(app)
      .put("/api/lessons/attendance")
      .set("Cookie", cookie)
      .send({ cycle: String(cycle._id), date: "2026-10-29", records: [{ student: String(a._id), status: "Present" }, { student: String(b._id), status: "Missing", reason: "hospital", note: "חזר מחר" }] });
    expect(res.status).toBeLessThan(300);
    await flush();
    const e = await AuditEvent.findOne({ route: "/lessons/attendance" }).lean();
    expect(e.summary).toMatch(/29\.10\.26/);
    expect(e.summary).toMatch(/2 דיווחים/);
    expect(e.summary).toMatch(/1 נכחו/);
    expect(e.summary).toMatch(/1 נעדרו/);
    expect(e.summary).not.toMatch(/[0-9a-f]{24}/);
    const byLabel = Object.fromEntries(e.facts.map((f) => [f.label, f.value]));
    expect(byLabel["דנה לוי"]).toBe("נכח");
    expect(byLabel["יוסי מזרחי"]).toBe("נעדר · אשפוז · חזר מחר");
    expect(byLabel["קורס"]).toBeTruthy();
  });

  test("a seat in words; an edit says what changed from what; a deletion keeps the name it had", async () => {
    const cycle = await makeCycle();
    const s = await makeStudent({ firstName: "רונית", lastName: "אבן" });
    const { cookie } = await signIn("hagai");
    const made = await request(app).post("/api/enrollments").set("Cookie", cookie).send({ cycle: String(cycle._id), student: String(s._id), status: "active" });
    expect(made.status).toBeLessThan(300);
    const room = await request(app).post("/api/rooms").set("Cookie", cookie).send({ name: "חדר ישן", capacity: 8 });
    const id = room.body.data.room._id;
    await request(app).put(`/api/rooms/${id}`).set("Cookie", cookie).send({ name: "חדר חדש", capacity: 12, notes: "" }).expect(200);
    await request(app).delete(`/api/rooms/${id}`).set("Cookie", cookie).expect(204);
    await flush();
    const seat = await AuditEvent.findOne({ route: "/enrollments" }).lean();
    expect(seat.summary).toMatch(/^רונית אבן שובץ\/ה ל/);
    const edit = await AuditEvent.findOne({ route: "/rooms/:id", method: "PUT" }).lean();
    expect(edit.changes.map((c) => [c.field, c.from, c.to])).toEqual([
      ["name", "חדר ישן", "חדר חדש"],
      ["capacity", "8", "12"],
    ]);
    expect(edit.summary).toBe("שם: מ-חדר ישן ל-חדר חדש · קיבולת: מ-8 ל-12");
    const gone = await AuditEvent.findOne({ route: "/rooms/:id", method: "DELETE" }).lean();
    expect(gone.target.label).toBe("חדר חדש");
    expect(gone.summary).toBe("חדר חדש");
  });

  test("the goodbye beacon takes a closed window off the online list; the sign-in row reads 'closed'", async () => {
    const { cookie: tamar } = await signIn("tamar", PHONE_UA);
    const { cookie: eden } = await signIn("eden");
    expect((await request(app).get("/api/audit/presence").set("Cookie", eden)).body.data.online.map((o) => o.account.username).sort()).toEqual(["eden", "tamar"]);
    await request(app).post("/api/auth/bye").set("Cookie", tamar).expect(204);
    expect((await request(app).get("/api/audit/presence").set("Cookie", eden)).body.data.online.map((o) => o.account.username)).toEqual(["eden"]);
    const tamarId = await idOf("tamar");
    const row = (await request(app).get(`/api/audit/logins?account=${tamarId}`).set("Cookie", eden)).body.data.logins[0];
    expect(row).toMatchObject({ live: true, state: "closed" });
    expect(row.leftAt).toBeTruthy();
    // the window opens again: a touch brings her back
    await request(app).get("/api/auth/me").set("Cookie", tamar).expect(200);
    expect((await request(app).get("/api/audit/presence").set("Cookie", eden)).body.data.online.map((o) => o.account.username).sort()).toEqual(["eden", "tamar"]);
  });

  test("clearing: the writes and the ended sign-ins go, live sign-ins stay, the clearing itself is written down", async () => {
    const { cookie: hagai } = await signIn("hagai");
    await request(app).post("/api/rooms").set("Cookie", hagai).send({ name: "א" }).expect(201);
    await request(app).post("/api/auth/logout").set("Cookie", hagai).expect(200);
    const { cookie: noa } = await signIn("noa");
    await request(app).post("/api/rooms").set("Cookie", noa).send({ name: "ב" }).expect(201);
    await flush();
    const { cookie: eden } = await signIn("eden");
    expect((await request(app).post("/api/audit/clear").set("Cookie", noa).send({ what: ["events"] })).status).toBe(403);
    const hagaiId = await idOf("hagai");
    const one = await request(app).post("/api/audit/clear").set("Cookie", eden).send({ what: ["events", "logins"], user: hagaiId });
    expect(one.body.data).toEqual({ events: 1, logins: 1 });
    await flush();
    expect(await AuditEvent.countDocuments({ actor: hagaiId })).toBe(0);
    expect(await StaffLogin.countDocuments({ account: hagaiId })).toBe(0);
    const all = await request(app).post("/api/audit/clear").set("Cookie", eden).send({ what: ["events", "logins"] });
    expect(all.body.data.events).toBe(2); // noa's room + the first clearing
    expect(all.body.data.logins).toBe(0); // noa's and eden's sign-ins are live
    await flush();
    const left = await AuditEvent.find().lean();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ title: "ניקוי היסטוריית הפעילות", verb: "delete", kind: "audit" });
    expect(left[0].summary).toMatch(/^נמחקו 2 פעולות ו-0 כניסות · של כולם/);
    expect(await StaffLogin.countDocuments()).toBe(2);
  });
});

describe("the describer (utils/auditDescribe)", () => {
  test("ids and tokens fold; the named routes answer in Hebrew; the rest fall back to the noun", () => {
    expect(normalizeRoute("/cycles/65f1a2b3c4d5e6f7a8b9c0d1/x")).toBe("/cycles/:id/x");
    expect(normalizeRoute("/public/join/AAAAAAAAAAAAAAAAAAAAb_c-9999/documents/psychiatric")).toBe("/public/join/:token/documents/psychiatric");
    expect(ruleFor("POST", "/enrollments")).toMatchObject({ title: "שיבוץ לקורס", verb: "create", kind: "enrollment" });
    expect(ruleFor("PUT", "/lessons/attendance")).toMatchObject({ title: "דיווח נוכחות", verb: "update" });
    expect(ruleFor("DELETE", "/tags/people/:id/hostels")).toMatchObject({ title: "הסרת תגית מאדם", verb: "delete" });
    expect(ruleFor("PUT", "/activities/templates/intake")).toMatchObject({ title: "עריכת תבנית תיעוד" });
    expect(ruleFor("PATCH", "/intakes/:id/documents/psychiatric")).toMatchObject({ title: "עדכון מסמך בתיק", kind: "document" });
    // unknown shapes: the noun of the first segment with the method's verb
    expect(ruleFor("POST", "/vouchers/:id/something-new")).toMatchObject({ title: "הוספת שובר", verb: "create", kind: "voucher" });
    expect(ruleFor("DELETE", "/nowhere/:id")).toMatchObject({ title: "DELETE /nowhere/:id", verb: "delete", kind: "" });
  });

  test("the payload: secrets out, long strings cut, pictures named, deep things folded", () => {
    const out = sanitizePayload({
      name: "x",
      password: "secret",
      token: "t",
      signatures: { a: "data:image/png;base64,AAAA" },
      photo: "data:image/jpeg;base64,ZZZZ",
      long: "א".repeat(300),
      list: [1, 2, 3, 4, 5, 6, 7, 8],
      nested: { deep: { deeper: { deepest: 1 } } },
    });
    expect(out.password).toBeUndefined();
    expect(out.token).toBeUndefined();
    expect(out.signatures).toBeUndefined();
    expect(out.photo).toBe("[תמונה]");
    expect(out.long.length).toBe(161);
    expect(out.list).toEqual([1, 2, 3, 4, 5, 6, "… ועוד 2"]);
    expect(out.nested).toEqual({ deep: "{…}" });
    expect(sanitizePayload({})).toBeNull();
    expect(sanitizePayload(null)).toBeNull();
    const d = describeWrite({ method: "POST", path: "/cycles", body: { subject: "x" }, answer: { status: "success", data: { cycle: { _id: "65f1a2b3c4d5e6f7a8b9c0d1", subject: { name: "יוגה" } } } } });
    expect(d).toMatchObject({ title: "קורס חדש", target: { id: "65f1a2b3c4d5e6f7a8b9c0d1", label: "יוגה" } });
  });

  test("a user agent in a few words", () => {
    expect(describeUserAgent(PC_UA)).toEqual({ browser: "Chrome", os: "Windows", mobile: false });
    expect(describeUserAgent(PHONE_UA)).toEqual({ browser: "Safari", os: "iPhone", mobile: true });
    expect(describeUserAgent("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")).toEqual({ browser: "Chrome", os: "Android", mobile: true });
    expect(describeUserAgent("")).toEqual({ browser: "", os: "", mobile: false });
  });
});
