/**
 * The app's look (Eden, 2026-11-19: "ההגדרות של ההנפשות ושל הכותרות יהיו רק
 * לעדן הסופר מנהל ומה שהוא יבחר זה ישפיע לכולם"): which opening animation
 * plays and how the headers are drawn is ONE choice for the whole app. It
 * comes with "who am I"; only the super admin's own account changes it. The
 * bypass actor's kind is borrowed (TEST_ACCOUNT).
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");

afterEach(() => {
  TEST_ACCOUNT.kind = "super";
});

const me = async () => (await request(app).get("/api/auth/me")).body.data;
const put = (body) => request(app).put("/api/auth/look").send(body);

describe("the app's look", () => {
  it("is nothing chosen at first, and comes with who-am-I", async () => {
    const d = await me();
    expect(d.account).toBeTruthy();
    expect(d.look).toEqual({ intro: null, head: null });
  });

  it("is the super admin's to choose, one choice at a time, and what he chose is what everyone is told", async () => {
    const a = await put({ intro: "curtain" });
    expect(a.status).toBe(200);
    expect(a.body.data.look).toEqual({ intro: "curtain", head: null });

    // the other choice alone: the first one stays
    const b = await put({ head: "shapes" });
    expect(b.body.data.look).toEqual({ intro: "curtain", head: "shapes" });

    // someone who is not the super admin is told the same, and cannot change it
    TEST_ACCOUNT.kind = "hostels";
    expect((await me()).look).toEqual({ intro: "curtain", head: "shapes" });
    const no = await put({ intro: "snap" });
    expect(no.status).toBe(403);
    expect((await me()).look.intro).toBe("curtain");

    TEST_ACCOUNT.kind = "super";
    const c = await put({ intro: "tour", head: "people" });
    expect(c.body.data.look).toEqual({ intro: "tour", head: "people" });

    // a choice can be taken back
    const d = await put({ intro: null });
    expect(d.body.data.look).toEqual({ intro: null, head: "people" });
  });

  it("takes only the designs it knows", async () => {
    expect((await put({ intro: "fireworks" })).status).toBe(400);
    expect((await put({ head: "neon" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ theme: "dark" })).status).toBe(400);
    expect((await me()).look).toEqual({ intro: null, head: null });
  });
});
