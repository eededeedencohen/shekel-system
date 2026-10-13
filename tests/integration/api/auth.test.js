/**
 * @file Auth - passwords, sessions, the users page (Eden, 2026-10-12)
 *
 * These run with AUTH_ENFORCE=1: the gate is real here (the other suites
 * run signed in as a super admin).
 */

const request = require("supertest");
const app = require("../../../app");
const StaffAccount = require("../../../models/StaffAccount");
const StaffSession = require("../../../models/StaffSession");
const { ensureSeedAccounts } = require("../../../services/authService");
const { defaultPasswordFor } = require("../../../utils/password");

beforeAll(() => {
  process.env.AUTH_ENFORCE = "1";
});
afterAll(() => {
  delete process.env.AUTH_ENFORCE;
});

const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const signIn = async (username, password = defaultPasswordFor(username)) => {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  return { res, cookie: cookieOf(res) };
};

describe("auth", () => {
  beforeEach(async () => {
    await ensureSeedAccounts();
  });

  test("the seed: six accounts, eden is the super admin, default passwords", async () => {
    expect(await StaffAccount.countDocuments()).toBe(6);
    expect(defaultPasswordFor("eden")).toBe("edeN!@#");
    const { res, cookie } = await signIn("eden");
    expect(res.status).toBe(200);
    expect(res.body.data.account).toMatchObject({ username: "eden", kind: "super", defaultPassword: true });
    expect(res.body.data.account.passwordHash).toBeUndefined();
    expect(cookie).toMatch(/^shekel_session=/);
    expect(res.headers["set-cookie"][0]).toMatch(/HttpOnly/);
  });

  test("the API is closed without a session; public + sign-in routes stay open", async () => {
    expect((await request(app).get("/api/people")).status).toBe(401);
    expect((await request(app).get("/api/health")).status).toBe(200);
    expect((await request(app).get("/api/public/join/options")).status).not.toBe(401);
    const { cookie } = await signIn("hagai");
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).body.data.account.username).toBe("hagai");
    expect((await request(app).get("/api/people").set("Cookie", cookie)).status).toBe(200);
  });

  test("a wrong password fails; five in a row lock the name for a while", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post("/api/auth/login").send({ username: "hagai", password: "nope" });
      expect(r.status).toBe(401);
    }
    const locked = await request(app).post("/api/auth/login").send({ username: "hagai", password: defaultPasswordFor("hagai") });
    expect(locked.status).toBe(429);
  });

  test("users page is the super admin's alone", async () => {
    const { cookie: yetav } = await signIn("yetav");
    expect((await request(app).get("/api/accounts").set("Cookie", yetav)).status).toBe(403);
    expect((await request(app).get("/api/db/schema").set("Cookie", yetav)).status).toBe(403);
    const { cookie: eden } = await signIn("eden");
    const list = await request(app).get("/api/accounts").set("Cookie", eden);
    expect(list.status).toBe(200);
    expect(list.body.data.accounts.map((a) => a.username)).toEqual(["eden", "hagai", "noa", "yetav", "tamar", "shiran"]);
  });

  test("viewing as someone: the super admin has that person's permissions; nobody else can borrow", async () => {
    const { cookie: eden } = await signIn("eden");
    const accounts = (await request(app).get("/api/accounts").set("Cookie", eden)).body.data.accounts;
    const shiran = accounts.find((a) => a.username === "shiran");
    const edenRow = accounts.find((a) => a.username === "eden");
    // eden viewing as שירן: the users page and the database are closed to him
    expect((await request(app).get("/api/accounts").set("Cookie", eden).set("X-Acting-As", shiran._id)).status).toBe(403);
    expect((await request(app).get("/api/db/schema").set("Cookie", eden).set("X-Acting-As", shiran._id)).status).toBe(403);
    // the rest of the API still answers him as her
    expect((await request(app).get("/api/people").set("Cookie", eden).set("X-Acting-As", shiran._id)).status).toBe(200);
    // viewing as himself, or a stale / unknown id: himself
    expect((await request(app).get("/api/accounts").set("Cookie", eden).set("X-Acting-As", edenRow._id)).status).toBe(200);
    expect((await request(app).get("/api/accounts").set("Cookie", eden).set("X-Acting-As", "000000000000000000000000")).status).toBe(200);
    expect((await request(app).get("/api/accounts").set("Cookie", eden).set("X-Acting-As", "nonsense")).status).toBe(200);
    // a non-super account cannot borrow the super admin
    const { cookie: yetav } = await signIn("yetav");
    expect((await request(app).get("/api/accounts").set("Cookie", yetav).set("X-Acting-As", edenRow._id)).status).toBe(403);
  });

  test("create, edit, the last super admin stays", async () => {
    const { cookie } = await signIn("eden");
    const made = await request(app).post("/api/accounts").set("Cookie", cookie).send({ username: "Dana", name: "דנה", kind: "manager", phone: "0501234567" });
    expect(made.status).toBe(201);
    expect(made.body.data.account).toMatchObject({ username: "dana", defaultPassword: true, active: true });
    expect((await signIn("dana", "danA!@#")).res.status).toBe(200);
    const dup = await request(app).post("/api/accounts").set("Cookie", cookie).send({ username: "dana", name: "x", kind: "manager" });
    expect(dup.status).toBe(409);
    const eden = await StaffAccount.findOne({ username: "eden" });
    const demote = await request(app).patch(`/api/accounts/${eden._id}`).set("Cookie", cookie).send({ kind: "manager" });
    expect(demote.status).toBe(409);
    // disabling ends the account's sessions
    const { cookie: dana } = await signIn("dana", "danA!@#");
    const off = await request(app).patch(`/api/accounts/${made.body.data.account._id}`).set("Cookie", cookie).send({ active: false });
    expect(off.body.data.account.active).toBe(false);
    expect((await request(app).get("/api/auth/me").set("Cookie", dana)).status).toBe(401);
  });

  test("my own password: the current one is checked, other browsers sign out", async () => {
    const { cookie: a } = await signIn("tamar");
    const { cookie: b } = await signIn("tamar");
    expect((await request(app).post("/api/auth/password").set("Cookie", a).send({ current: "wrong", next: "abcdef1" })).status).toBe(400);
    expect((await request(app).post("/api/auth/password").set("Cookie", a).send({ current: "tamaR!@#", next: "123" })).status).toBe(400);
    const done = await request(app).post("/api/auth/password").set("Cookie", a).send({ current: "tamaR!@#", next: "new-pass-1" });
    expect(done.status).toBe(200);
    expect(done.body.data.account.defaultPassword).toBe(false);
    expect((await request(app).get("/api/auth/me").set("Cookie", a)).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", b)).status).toBe(401);
    expect((await signIn("tamar", "new-pass-1")).res.status).toBe(200);
  });

  test("forgot → flagged; the reset link sets a new password once and signs in", async () => {
    await request(app).post("/api/auth/forgot").send({ username: "shiran" }).expect(200);
    await request(app).post("/api/auth/forgot").send({ username: "nobody" }).expect(200);
    const { cookie } = await signIn("eden");
    let list = (await request(app).get("/api/accounts").set("Cookie", cookie)).body.data.accounts;
    const shiran = list.find((a) => a.username === "shiran");
    expect(shiran.resetRequestedAt).toBeTruthy();

    const token = "A".repeat(20) + "b_c-" + "9".repeat(20);
    const made = await request(app).post(`/api/accounts/${shiran._id}/reset`).set("Cookie", cookie).send({ token });
    expect(made.status).toBe(201);
    // the same token again is the same link (a retry), not an error
    expect((await request(app).post(`/api/accounts/${shiran._id}/reset`).set("Cookie", cookie).send({ token })).status).toBe(201);

    const info = await request(app).get(`/api/auth/reset/${token}`);
    expect(info.body.data).toMatchObject({ username: "shiran", name: "שירן דרעי" });
    const set = await request(app).post(`/api/auth/reset/${token}`).send({ password: "shiran-2026" });
    expect(set.status).toBe(200);
    expect(cookieOf(set)).toMatch(/^shekel_session=/);
    expect((await request(app).post(`/api/auth/reset/${token}`).send({ password: "again-123" })).status).toBe(404);
    expect((await signIn("shiran", "shiran-2026")).res.status).toBe(200);
    list = (await request(app).get("/api/accounts").set("Cookie", cookie)).body.data.accounts;
    expect(list.find((a) => a.username === "shiran").resetRequestedAt).toBeNull();
  });

  test("sign out ends the session", async () => {
    const { cookie } = await signIn("noa");
    await request(app).post("/api/auth/logout").set("Cookie", cookie).expect(200);
    expect(await StaffSession.countDocuments()).toBe(0);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(401);
  });
});
