/**
 * @file The diary (שמרית's יומן, 2026-10-14; Eden 2026-11-08: "כמו פתקים עם
 * צבעים") - a note on a day, a task done or not, a paper colour per note.
 * Runs through the test bypass; the diary is the acting account's own.
 */

const request = require("supertest");
const app = require("../../../app");
const DiaryEntry = require("../../../models/DiaryEntry");
const { DIARY_COLORS } = require("../../../utils/domain");

describe("the diary", () => {
  test("a note keeps its paper colour, yellow when none or unknown; a day lists in order; the colour and the tick change; a removed note is gone", async () => {
    expect(DIARY_COLORS[0]).toBe("yellow");

    const made = await request(app).post("/api/diary").send({ date: "2026-11-12", title: "המורה טס לחו\"ל", body: "חוזר ב-20", kind: "note", color: "blue" });
    expect(made.status).toBe(201);
    expect(made.body.data.entry).toMatchObject({ date: "2026-11-12", title: "המורה טס לחו\"ל", body: "חוזר ב-20", kind: "note", color: "blue", done: false });

    const plain = await request(app).post("/api/diary").send({ date: "2026-11-12", title: "להתקשר לספק", kind: "task" });
    expect(plain.status).toBe(201);
    expect(plain.body.data.entry.color).toBe("yellow");

    const odd = await request(app).post("/api/diary").send({ date: "2026-11-13", title: "צבע שאינו קיים", color: "neon" });
    expect(odd.status).toBe(201);
    expect(odd.body.data.entry.color).toBe("yellow");

    const list = await request(app).get("/api/diary").query({ from: "2026-11-12", to: "2026-11-12" });
    expect(list.status).toBe(200);
    expect(list.body.data.entries.map((e) => e.title)).toEqual(["המורה טס לחו\"ל", "להתקשר לספק"]);

    const id = plain.body.data.entry._id;
    const changed = await request(app).patch(`/api/diary/${id}`).send({ color: "pink", done: true });
    expect(changed.status).toBe(200);
    expect(changed.body.data.entry.color).toBe("pink");
    expect(changed.body.data.entry.done).toBe(true);
    expect(changed.body.data.entry.doneAt).toBeTruthy();

    const back = await request(app).patch(`/api/diary/${id}`).send({ color: "neon", done: false });
    expect(back.body.data.entry.color).toBe("yellow");
    expect(back.body.data.entry.done).toBe(false);
    expect(back.body.data.entry.doneAt).toBeNull();

    expect((await request(app).post("/api/diary").send({ date: "12/11/2026", title: "תאריך לא תקין" })).status).toBe(400);
    expect((await request(app).post("/api/diary").send({ date: "2026-11-12", title: "   " })).status).toBe(400);

    expect((await request(app).delete(`/api/diary/${id}`)).status).toBe(204);
    expect((await request(app).patch(`/api/diary/${id}`).send({ title: "כבר נמחק" })).status).toBe(404);
    expect(await DiaryEntry.countDocuments({ date: { $in: ["2026-11-12", "2026-11-13"] } })).toBe(2);
  });
});
