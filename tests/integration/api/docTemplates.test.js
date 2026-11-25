/**
 * The staff's written templates - "מיני docs" (Eden, 2026-11-19): "מי
 * שיוצר את הטמפלט הוא היחיד שיכול לערוך אותו אבל כולם יכולים להשתמש בו
 * ואפילו להעתיק אותו לטמפלט משלהם". The document is a checked tree, never
 * HTML; an entry of a person's record written with its design keeps the
 * tree and its plain lines. The bypass actor is borrowed (TEST_ACCOUNT):
 * another username is another person.
 *
 * Who sees and who manages (Eden, 2026-11-25): "אני יכול לראות הכול ולנהל
 * מי יוכל לראות את התבניות. רק אני ויוצר התבנית יכולים לערוך… אחרים שיש
 * להם הרשאות צפייה יכולים להשתמש בתבנית ולהעתיק אותה. ההעתק יהיה שייך
 * אליהם. יוצר התבנית יוכל להגדיר מי מהעובדים יוכל להשתמש בתבנית".
 */

const request = require("supertest");
const app = require("../../../app");
const DocTemplate = require("../../../models/DocTemplate");
const Activity = require("../../../models/Activity");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const { cleanDoc, textOf, docFromText } = require("../../../utils/richDoc");
const { makeStudent } = require("../../helpers/factories");

const actAs = ({ username = "test", name = "בדיקות", kind = "super" } = {}) => Object.assign(TEST_ACCOUNT, { username, name, kind });
afterEach(() => actAs());

const p = (text, marks, attrs) => ({ type: "paragraph", ...(attrs && { attrs }), content: [{ type: "text", text, ...(marks && { marks }) }] });
const DOC = {
  type: "doc",
  content: [
    p("שיחת הערכה", [{ type: "bold" }, { type: "size", attrs: { v: "xl" } }, { type: "color", attrs: { v: "violet" } }], { align: "center" }),
    p("מה השתנה מאז הפעם הקודמת?", [{ type: "mark", attrs: { v: "yellow" } }]),
    { type: "bullet_list", content: [{ type: "list_item", content: [p("בלימודים")] }, { type: "list_item", content: [p("בבית", null, { indent: 2 })] }] },
    { type: "horizontal_rule" },
    p("סיכום:", [{ type: "underline" }]),
  ],
};

describe("the staff's written templates", () => {
  it("are made by anyone on the staff, read by everyone, and kept with their plain lines", async () => {
    actAs({ username: "noa", name: "נעה", kind: "manager" });
    const made = await request(app).post("/api/doc-templates").send({ name: "  שיחת הערכה   שנתית ", kind: "evaluation", doc: DOC });
    expect(made.status).toBe(201);
    const t = made.body.data.template;
    expect(t.name).toBe("שיחת הערכה שנתית");
    expect(t.kind).toBe("evaluation");
    expect(t.owner).toBe("noa");
    expect(t.ownerName).toBe("נעה");
    expect(t.doc).toEqual(DOC);
    expect(t.text).toBe("שיחת הערכה\nמה השתנה מאז הפעם הקודמת?\n• בלימודים\n• בבית\n\nסיכום:");

    actAs({ username: "shimrit", name: "שמרית", kind: "hostels" });
    const all = await request(app).get("/api/doc-templates");
    expect(all.status).toBe(200);
    expect(all.body.data.templates.map((x) => x.name)).toEqual(["שיחת הערכה שנתית"]);
  });

  it("are changed and deleted by the one who made them and by the super admin - nobody else", async () => {
    actAs({ username: "noa", name: "נעה", kind: "manager" });
    const id = (await request(app).post("/api/doc-templates").send({ name: "מעקב", kind: "followUp", doc: DOC })).body.data.template._id;

    actAs({ username: "hagai", name: "חגי", kind: "manager" });
    const patch = await request(app).patch(`/api/doc-templates/${id}`).send({ name: "שלי עכשיו" });
    expect(patch.status).toBe(403);
    expect(patch.body.code).toBe("TEMPLATE_NOT_YOURS");
    expect((await request(app).delete(`/api/doc-templates/${id}`)).status).toBe(403);
    expect((await request(app).put(`/api/doc-templates/${id}/audience`).send({ audience: "some", viewers: [] })).status).toBe(403);
    expect((await DocTemplate.findById(id)).name).toBe("מעקב");

    // the super admin changes it - and it stays hers
    actAs({ username: "eden", name: "עדן", kind: "super" });
    const his = await request(app).patch(`/api/doc-templates/${id}`).send({ name: "מעקב חודשי" });
    expect(his.status).toBe(200);
    expect(his.body.data.template).toMatchObject({ name: "מעקב חודשי", owner: "noa", ownerName: "נעה" });

    actAs({ username: "noa", name: "נעה כהן", kind: "manager" });
    const mine = await request(app).patch(`/api/doc-templates/${id}`).send({ name: "מעקב רבעוני", kind: null, doc: docFromText("שורה אחת\nשורה שתיים") });
    expect(mine.status).toBe(200);
    expect(mine.body.data.template).toMatchObject({ name: "מעקב רבעוני", kind: null, text: "שורה אחת\nשורה שתיים", ownerName: "נעה כהן" });
    // one field alone: the others stay
    const nameOnly = await request(app).patch(`/api/doc-templates/${id}`).send({ name: "" });
    expect(nameOnly.body.data.template).toMatchObject({ name: "תבנית בלי שם", text: "שורה אחת\nשורה שתיים" });
    expect((await request(app).delete(`/api/doc-templates/${id}`)).status).toBe(204);
    expect(await DocTemplate.countDocuments()).toBe(0);
    expect((await request(app).patch(`/api/doc-templates/${id}`).send({ name: "x" })).status).toBe(404);
    expect((await request(app).patch("/api/doc-templates/nope").send({ name: "x" })).status).toBe(404);
  });

  it("can be copied by anyone into a template of their own - the source is read here, not taken from the request", async () => {
    actAs({ username: "noa", name: "נעה", kind: "manager" });
    const src = (await request(app).post("/api/doc-templates").send({ name: "מעקב", kind: "followUp", doc: DOC })).body.data.template;

    actAs({ username: "hagai", name: "חגי", kind: "manager" });
    const copy = await request(app).post("/api/doc-templates").send({ name: "מעקב - עותק", kind: src.kind, doc: src.doc, copiedFrom: src._id, owner: "noa", ownerName: "מישהו" });
    expect(copy.status).toBe(201);
    const c = copy.body.data.template;
    expect(c.owner).toBe("hagai");
    expect(c.ownerName).toBe("חגי");
    expect(c.copiedFrom).toMatchObject({ template: src._id, name: "מעקב", ownerName: "נעה" });
    // his own now: he changes it, and hers stays as it was
    expect((await request(app).patch(`/api/doc-templates/${c._id}`).send({ doc: docFromText("אחרת") })).status).toBe(200);
    expect((await DocTemplate.findById(src._id)).text).toContain("שיחת הערכה");
    // a source that is no template is simply not remembered
    const loose = await request(app).post("/api/doc-templates").send({ name: "חדשה", copiedFrom: "nope" });
    expect(loose.status).toBe(201);
    expect(loose.body.data.template.copiedFrom).toBeUndefined();
    expect(loose.body.data.template.text).toBe("");
  });

  it("is seen by whoever its maker named - everyone, some, or the maker alone - and always by the super admin", async () => {
    const seen = async (who) => {
      actAs(who);
      return (await request(app).get("/api/doc-templates")).body.data.templates.map((x) => x.name).sort();
    };
    const noa = { username: "noa", name: "נעה", kind: "manager" };
    const hagai = { username: "hagai", name: "חגי", kind: "manager" };
    const yitav = { username: "yitav", name: "ייטב", kind: "social" };
    const eden = { username: "eden", name: "עדן", kind: "super" };
    actAs(noa);
    const open = (await request(app).post("/api/doc-templates").send({ name: "לכולם", doc: DOC })).body.data.template;
    expect(open).toMatchObject({ audience: "all", viewers: [] });
    // said from the first save: hers alone
    const shut = (await request(app).post("/api/doc-templates").send({ name: "פרטית", doc: DOC, audience: "some", viewers: [] })).body.data.template;
    expect(shut).toMatchObject({ audience: "some", viewers: [] });
    expect(await seen(hagai)).toEqual(["לכולם"]);
    expect(await seen(eden)).toEqual(["לכולם", "פרטית"]);

    // she names חגי: he sees it, ייטב does not. Her own name in the list is dropped - the maker always sees
    actAs(noa);
    const named = await request(app).put(`/api/doc-templates/${shut._id}/audience`).send({ audience: "some", viewers: ["hagai", "noa", "hagai", "<script>"] });
    expect(named.status).toBe(200);
    expect(named.body.data.template).toMatchObject({ audience: "some", viewers: ["hagai"] });
    // (who reads it changed, the document did not: "last changed" stays)
    expect(named.body.data.template.updatedAt).toBe(shut.updatedAt);
    expect(await seen(hagai)).toEqual(["לכולם", "פרטית"]);
    expect(await seen(yitav)).toEqual(["לכולם"]);

    // for whoever does not see it, it does not exist: nothing to change, to share, or to copy the name of
    actAs(yitav);
    expect((await request(app).patch(`/api/doc-templates/${shut._id}`).send({ name: "x" })).status).toBe(404);
    expect((await request(app).put(`/api/doc-templates/${shut._id}/audience`).send({ audience: "all" })).status).toBe(404);
    const blind = await request(app).post("/api/doc-templates").send({ name: "ניחוש", copiedFrom: shut._id });
    expect(blind.body.data.template.copiedFrom).toBeUndefined();
    await request(app).delete(`/api/doc-templates/${blind.body.data.template._id}`);

    // חגי sees it: he writes from it and copies it - the copy is his, and his alone until he says otherwise
    actAs(hagai);
    expect((await request(app).patch(`/api/doc-templates/${shut._id}`).send({ name: "x" })).body.code).toBe("TEMPLATE_NOT_YOURS");
    const copy = (await request(app).post("/api/doc-templates").send({ name: "פרטית - עותק", doc: shut.doc, copiedFrom: shut._id })).body.data.template;
    expect(copy).toMatchObject({ owner: "hagai", audience: "some", viewers: [] });
    expect(await seen(noa)).toEqual(["לכולם", "פרטית"]);
    // a copy of a template everyone sees is seen by everyone, as any new template
    const openCopy = (await request(app).post("/api/doc-templates").send({ name: "לכולם - עותק", doc: open.doc, copiedFrom: open._id })).body.data.template;
    expect(openCopy.audience).toBe("all");

    // the super admin says who sees anyone's template
    actAs(eden);
    expect((await request(app).put(`/api/doc-templates/${shut._id}/audience`).send({ audience: "all" })).body.data.template).toMatchObject({ audience: "all", viewers: [] });
    expect(await seen(yitav)).toEqual(["לכולם", "לכולם - עותק", "פרטית"]);
    actAs(eden);
    for (const bad of [{}, { audience: "nobody" }, { audience: "some", viewers: "hagai" }]) {
      expect((await request(app).put(`/api/doc-templates/${shut._id}/audience`).send(bad)).body.code).toBe("TEMPLATE_AUDIENCE_INVALID");
    }
  });

  it("keeps only what a document is made of", async () => {
    const dirty = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { align: "justify", indent: 99, style: "color:red", onclick: "x()" }, content: [
          { type: "text", text: "שלום", marks: [{ type: "bold" }, { type: "bold" }, { type: "link", attrs: { href: "javascript:alert(1)" } }, { type: "color", attrs: { v: "#ff0000" } }, { type: "size", attrs: { v: "lg" } }] },
          { type: "image", attrs: { src: "x" } },
          { type: "hard_break" },
          { type: "text", text: "" },
        ] },
        { type: "script", content: [{ type: "text", text: "alert(1)" }] },
        { type: "html", html: "<img onerror=x>" },
        { type: "ordered_list", content: [{ type: "paragraph" }, { type: "list_item", content: [{ type: "bullet_list", content: [{ type: "list_item", content: [p("פנימי")] }] }] }] },
        { type: "bullet_list", content: [] },
      ],
    };
    expect(cleanDoc(dirty)).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { indent: 6 }, content: [{ type: "text", text: "שלום", marks: [{ type: "bold" }, { type: "size", attrs: { v: "lg" } }] }, { type: "hard_break" }] },
        { type: "ordered_list", content: [{ type: "list_item", content: [{ type: "paragraph" }, { type: "bullet_list", content: [{ type: "list_item", content: [p("פנימי")] }] }] }] },
      ],
    });
    expect(textOf(cleanDoc(dirty))).toBe("שלום\n\n1. \n   • פנימי");
    // nothing left → one empty paragraph; no document at all, or one far too long → refused
    expect(cleanDoc({ type: "doc", content: [{ type: "table" }] })).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    for (const bad of ["<p>x</p>", { type: "paragraph" }, { type: "doc" }, []]) {
      const r = await request(app).post("/api/doc-templates").send({ name: "x", doc: bad });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("DOC_INVALID");
    }
    const long = { type: "doc", content: Array.from({ length: 70 }, () => p("א".repeat(1000))) };
    expect((await request(app).post("/api/doc-templates").send({ name: "x", doc: long })).body.code).toBe("DOC_TOO_LONG");
    expect(await DocTemplate.countDocuments()).toBe(0);
  });
});

describe("an entry of the record written with its design", () => {
  it("keeps the document and its plain lines; plain words written over it drop the design", async () => {
    const person = await makeStudent();
    const made = await request(app).post("/api/activities").send({ person: person._id, kind: "update", doc: DOC, body: "לא זה" });
    expect(made.status).toBe(201);
    const a = made.body.data.activity;
    expect(a.doc).toEqual(DOC);
    expect(a.body).toBe("שיחת הערכה\nמה השתנה מאז הפעם הקודמת?\n• בלימודים\n• בבית\n\nסיכום:");

    const edited = await request(app).patch(`/api/activities/${a._id}`).send({ doc: docFromText("עודכן") });
    expect(edited.body.data.activity.body).toBe("עודכן");
    expect(edited.body.data.activity.doc.content).toHaveLength(1);

    const plain = await request(app).patch(`/api/activities/${a._id}`).send({ body: "מילים פשוטות" });
    expect(plain.body.data.activity.body).toBe("מילים פשוטות");
    expect((await Activity.findById(a._id).lean()).doc).toBeUndefined();

    // a document with nothing written in it is no document
    const empty = await request(app).post("/api/activities").send({ person: person._id, kind: "update", doc: { type: "doc", content: [{ type: "paragraph" }] } });
    expect(empty.body.data.activity.body).toBe("");
    expect((await Activity.findById(empty.body.data.activity._id).lean()).doc).toBeUndefined();
    expect((await request(app).post("/api/activities").send({ person: person._id, kind: "update", doc: "<b>x</b>" })).body.code).toBe("DOC_INVALID");
  });
});
