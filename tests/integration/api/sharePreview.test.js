/**
 * The share preview stamped into the served page — what WhatsApp sees for
 * a pasted link. Runs only when the client build is present (client-dist/
 * is what the SPA fallback serves); a bare API checkout skips it.
 */

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../../../app");
const { makeEvent, makeCycle, makeSubject, makeBook, makeStudent } = require("../../helpers/factories");

const hasBuild = fs.existsSync(path.join(__dirname, "../../../client-dist/index.html"));
const d = hasBuild ? describe : describe.skip;

const og = (html, prop) => {
  const m = new RegExp(`<meta property="og:${prop}" content="([^"]*)"`).exec(html);
  return m ? m[1] : null;
};

d("share previews on the served page", () => {
  it("each section gets its own title and text; the picture is the logo and the URL is absolute", async () => {
    const join = await request(app).get("/join").set("X-Forwarded-Proto", "https").set("X-Forwarded-Host", "shekel.example");
    expect(join.status).toBe(200);
    expect(join.headers["content-type"]).toMatch(/text\/html/);
    expect(join.headers["cache-control"]).toBe("no-cache");
    expect(og(join.text, "title")).toBe("הצטרפות לשק״ל");
    expect(og(join.text, "image")).toBe("https://shekel.example/og/logo.png");
    expect(og(join.text, "url")).toBe("https://shekel.example/join");
    expect(join.text).toContain("<title>הצטרפות לשק״ל</title>");

    const culture = await request(app).get("/culture?tab=vouchers");
    expect(og(culture.text, "image")).toMatch(/\/og\/logo\.png$/);
    expect(og(culture.text, "title")).toBe("תרבות לכל · שק״ל");
    expect(og(culture.text, "description")).not.toBe(og(join.text, "description"));

    const home = await request(app).get("/");
    expect(og(home.text, "title")).toBe("שק״ל · מכללה לכל");
    const picture = await request(app).get("/og/logo.png");
    expect(picture.status).toBe(200);
    expect(picture.headers["content-type"]).toMatch(/image\/png/);
  });

  it("an event link names the event (day · time · kind · place), a course its subject, a book its title", async () => {
    const ev = await makeEvent({ name: "סטנדאפ — שלומי קוריאט", date: new Date("2026-09-16T17:00:00Z"), endTime: "22:00", category: "standup", location: "זאפה ירושלים" });
    const evPage = await request(app).get(`/culture/events/${ev._id}`);
    expect(og(evPage.text, "title")).toBe("סטנדאפ — שלומי קוריאט · תרבות לכל");
    expect(og(evPage.text, "description")).toBe("יום רביעי, 16 בספטמבר · 20:00–22:00 · סטנדאפ · זאפה ירושלים");

    const subject = await makeSubject({ name: "אנגלית" });
    const cycle = await makeCycle({ subject: subject._id, schedule: [{ day: 2, start: "08:00", end: "09:30" }] });
    const coursePage = await request(app).get(`/courses/${cycle._id}`);
    expect(og(coursePage.text, "title")).toBe("אנגלית · מכללה לכל");
    expect(og(coursePage.text, "description")).toBe("יום שלישי 08:00–09:30");

    const book = await makeBook({ title: "הזוג מהבית השכן", author: "שרי לפניה" });
    const bookPage = await request(app).get(`/library?book=${book._id}`);
    expect(og(bookPage.text, "title")).toBe("הזוג מהבית השכן · הספרייה");
    expect(og(bookPage.text, "description")).toMatch(/^שרי לפניה/);
  });

  it("a student page never names the person; an unknown id falls back to the section", async () => {
    const s = await makeStudent({ firstName: "נועה", lastName: "פרטית" });
    const page = await request(app).get(`/students/${s._id}`);
    expect(og(page.text, "title")).toBe("סטודנטים · מכללה לכל");
    expect(page.text).not.toContain("נועה פרטית");
    const missing = await request(app).get("/culture/events/6aa128921cc122dde93a3577");
    expect(og(missing.text, "title")).toBe("תרבות לכל · שק״ל");
  });

  it("the service worker and the manifest are never cached; the API is not swallowed", async () => {
    const sw = await request(app).get("/sw.js");
    if (sw.status === 200) expect(sw.headers["cache-control"]).toBe("no-cache");
    const manifest = await request(app).get("/manifest.webmanifest");
    if (manifest.status === 200) expect(manifest.headers["cache-control"]).toBe("no-cache");
    const api = await request(app).get("/api/nope");
    expect(api.status).toBe(404);
    expect(api.headers["content-type"]).toMatch(/json/);
  });
});
