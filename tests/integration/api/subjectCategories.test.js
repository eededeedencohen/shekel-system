/**
 * The catalogue's categories (Eden, 2026-10-25): the built-in list plus the
 * ones the staff name - "אם היא תסמן על קטגוריה אחר היא חייבת לתת לזה שם".
 * A named category is a small table of its own; its key is its id; a
 * subject's category must be a built-in key or a named one; the meta
 * payload and the public sign-up options serve both lists as one.
 */

const request = require("supertest");
const app = require("../../../app");
const { makeSubject } = require("../../helpers/factories");
const { SUBJECT_CATEGORIES } = require("../../../utils/domain");

describe("named subject categories", () => {
  it("a named category joins the built-ins in /api/meta/domain and the public options, by its id", async () => {
    const made = await request(app).post("/api/subject-categories").send({ label: "  גינון  וטבע " });
    expect(made.status).toBe(201);
    const cat = made.body.data.subjectCategory;
    expect(cat.label).toBe("גינון וטבע");
    expect(cat.key).toBe(String(cat._id));

    const listed = await request(app).get("/api/subject-categories");
    expect(listed.body.data.subjectCategories.map((c) => c.key)).toEqual([cat.key]);

    const meta = await request(app).get("/api/meta/domain");
    const keys = meta.body.data.domain.subjectCategories.map((c) => c.key);
    expect(keys.slice(0, SUBJECT_CATEGORIES.length)).toEqual(SUBJECT_CATEGORIES.map((c) => c.key));
    expect(keys[keys.length - 1]).toBe(cat.key);
    expect(meta.body.data.domain.subjectCategories.find((c) => c.key === cat.key)).toMatchObject({ label: "גינון וטבע", custom: true });

    const pub = await request(app).get("/api/public/join/options");
    expect(pub.body.data.options.subjectCategories.some((c) => c.key === cat.key && c.label === "גינון וטבע")).toBe(true);
  });

  it("the same name twice is refused - a built-in's name too, whatever the case or spacing", async () => {
    await request(app).post("/api/subject-categories").send({ label: "גינון" });
    const again = await request(app).post("/api/subject-categories").send({ label: "גינון " });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("SUBJECT_CATEGORY_EXISTS");
    const builtIn = await request(app).post("/api/subject-categories").send({ label: "מוזיקה" });
    expect(builtIn.status).toBe(409);
    const empty = await request(app).post("/api/subject-categories").send({ label: "   " });
    expect(empty.status).toBe(400);
  });

  it("a subject takes a built-in key or a named category's id; anything else is refused", async () => {
    const cat = (await request(app).post("/api/subject-categories").send({ label: "גינון" })).body.data.subjectCategory;
    const named = await request(app).post("/api/subjects").send({ name: "גינון טיפולי", category: cat.key });
    expect(named.status).toBe(201);
    expect(named.body.data.subject.category).toBe(cat.key);
    const builtIn = await request(app).post("/api/subjects").send({ name: "תופים", category: "music" });
    expect(builtIn.status).toBe(201);
    const bare = await request(app).post("/api/subjects").send({ name: "חידות" });
    expect(bare.status).toBe(201);
    expect(bare.body.data.subject.category).toBe("other");
    const unknown = await request(app).post("/api/subjects").send({ name: "שחמט", category: "chess" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("SUBJECT_CATEGORY_UNKNOWN");
    const moved = await request(app).put(`/api/subjects/${builtIn.body.data.subject._id}`).send({ category: "nope" });
    expect(moved.status).toBe(400);
    const movedRight = await request(app).put(`/api/subjects/${builtIn.body.data.subject._id}`).send({ category: cat.key });
    expect(movedRight.status).toBe(200);
    expect(movedRight.body.data.subject.category).toBe(cat.key);
  });

  it("a category in use cannot be deleted; renaming keeps the subjects (they hold the id)", async () => {
    const cat = (await request(app).post("/api/subject-categories").send({ label: "גינון" })).body.data.subjectCategory;
    const subject = await makeSubject({ name: "גינון טיפולי", category: cat.key });
    const blocked = await request(app).delete(`/api/subject-categories/${cat.key}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("REFERENCED_BLOCKED");

    const renamed = await request(app).put(`/api/subject-categories/${cat.key}`).send({ label: "גינון ונוף" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.subjectCategory.label).toBe("גינון ונוף");
    const clash = await request(app).put(`/api/subject-categories/${cat.key}`).send({ label: "אומנות" });
    expect(clash.status).toBe(409);

    await request(app).delete(`/api/subjects/${subject._id}`).expect(204);
    await request(app).delete(`/api/subject-categories/${cat.key}`).expect(204);
    const gone = await request(app).post("/api/subjects").send({ name: "גינון טיפולי", category: cat.key });
    expect(gone.status).toBe(400);
    expect(gone.body.code).toBe("SUBJECT_CATEGORY_UNKNOWN");
  });
});
