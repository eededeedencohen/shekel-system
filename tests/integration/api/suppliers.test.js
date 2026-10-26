/**
 * פתיחת תיק ספק (Eden, 2026-10-14): the coordinator's link, the supplier's
 * form and files behind it, the coordinator's verdicts, the mail steps.
 *
 * Runs with AUTH_ENFORCE=1 so req.actor is the real persona: the page is
 * the hostels coordinator's (and the super admin's), nobody else's.
 */

const request = require("supertest");
const app = require("../../../app");
const Supplier = require("../../../models/Supplier");
const StoredFile = require("../../../models/StoredFile");
const { ensureSeedAccounts } = require("../../../services/authService");
const { defaultPasswordFor } = require("../../../utils/password");

beforeAll(() => {
  process.env.AUTH_ENFORCE = "1";
});
afterAll(() => {
  delete process.env.AUTH_ENFORCE;
});

const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const signIn = async (username) => cookieOf(await request(app).post("/api/auth/login").send({ username, password: defaultPasswordFor(username) }));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const GOOD_FORM = {
  companyName: "דוגמה בע\"מ",
  businessId: "512345678",
  address: { city: "ירושלים", street: "יד חרוצים", number: "11", zip: "9153002" },
  officePhone: "02-6720157",
  contactName: "רונית",
  contactPhone: "050-1234567",
  contactEmail: "Ronit@Example.org",
  accountOwners: "דוגמה בע\"מ",
  bank: { code: 12, name: "בנק הפועלים" },
  branch: { code: 600, name: "סניף ראשי" },
  accountNumber: "123456",
  paymentTerms: "מזומן", // ignored - the terms are fixed
};

describe("/api/suppliers + /api/public/supplier/:token", () => {
  let tamar;
  /** The supplier's token from its own route (the staff answers carry none since 2026-10-26). */
  const tokenOf = async (s, cookie = tamar) => (await request(app).get(`/api/suppliers/${s._id}/link`).set("Cookie", cookie)).body.data.link.token;
  let hagai;
  let eden;
  beforeEach(async () => {
    await ensureSeedAccounts();
    tamar = await signIn("tamar");
    hagai = await signIn("hagai");
    eden = await signIn("eden");
  });

  const create = (cookie, body = {}) =>
    request(app).post("/api/suppliers").set("Cookie", cookie).send({ firstName: "דנה", lastName: "לוי", gender: "female", phone: "050-0000000", days: 7, ...body });
  const pub = (token) => `/api/public/supplier/${token}`;
  const upload = (token, key, extra = {}) => request(app).post(`${pub(token)}/files/${key}`).send({ fileName: "a.png", mime: "image/png", data: PNG.toString("base64"), ...extra });
  const review = (cookie, id, body) => request(app).post(`/api/suppliers/${id}/review`).set("Cookie", cookie).send(body);
  const email = (cookie, id, body) => request(app).post(`/api/suppliers/${id}/email`).set("Cookie", cookie).send(body);

  /** A supplier with the form sent and every certificate in - ready for the coordinator. */
  async function readySupplier(cookie = tamar) {
    const s = (await create(cookie)).body.data.supplier;
    const t = await tokenOf(s);
    expect((await request(app).put(`${pub(t)}/form`).send(GOOD_FORM)).status).toBe(200);
    for (const key of ["books", "withholding", "bankProof"]) expect((await upload(t, key)).status).toBe(200);
    expect((await request(app).post(`${pub(t)}/files/exempt/not-applicable`).send({ value: true })).status).toBe(200);
    return { id: s._id, token: t };
  }

  it("is the hostels coordinator's page (and the super admin's) - nobody else's", async () => {
    expect((await create(hagai)).status).toBe(403);
    expect((await request(app).get("/api/suppliers").set("Cookie", hagai)).status).toBe(403);
    expect((await create(eden)).status).toBe(201);
    const res = await create(tamar);
    expect(res.status).toBe(201);
    expect(res.body.data.supplier).toMatchObject({ firstName: "דנה", gender: "female", status: "link", statusLabel: "נשלח קישור", linkLive: true, createdBy: "תמר צימרינג" });
    expect(res.body.data.supplier.link.token).toBeUndefined(); // the token stays on the server - GET /:id/link hands the address
    expect(res.body.data.supplier.link.hasToken).toBe(true);
    expect(await tokenOf(res.body.data.supplier)).toMatch(/^[\w-]{20,}$/);
    expect(new Date(res.body.data.supplier.link.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    const list = await request(app).get("/api/suppliers").set("Cookie", tamar);
    expect(list.body.data.suppliers.map((x) => x._id)).toContain(res.body.data.supplier._id);
  });

  it("refuses a supplier without the basics, or with a link length off the list", async () => {
    expect((await create(tamar, { gender: "x" })).status).toBe(400);
    expect((await create(tamar, { phone: "123" })).status).toBe(400);
    const days = await create(tamar, { days: 5 });
    expect(days.status).toBe(400);
    expect(days.body.code).toBe("SUPPLIER_LINK_DAYS_INVALID");
  });

  it("the link opens the supplier's own view, notes the first opening, and locks when its time is over", async () => {
    const s = (await create(tamar)).body.data.supplier;
    const t0 = await tokenOf(s);
    const view = await request(app).get(pub(t0));
    expect(view.status).toBe(200);
    expect(view.body.data.view).toMatchObject({ firstName: "דנה", gender: "female", status: "link", paymentTerms: "שוטף + 60", form: null });
    expect(view.body.data.view.files.map((f) => f.key)).toEqual(["books", "withholding", "bankProof", "exempt"]);
    expect(view.body.data.view).not.toHaveProperty("link.token");
    const after = (await request(app).get(`/api/suppliers/${s._id}`).set("Cookie", tamar)).body.data.supplier;
    expect(after.link.openedAt).toBeTruthy();
    expect(after.unseen).toBe(1);

    expect((await request(app).get(pub("nope"))).status).toBe(404);
    await Supplier.updateOne({ _id: s._id }, { "link.expiresAt": new Date(Date.now() - 1000) });
    const expired = await request(app).get(pub(t0));
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe("SUPPLIER_LINK_EXPIRED");
    // the coordinator opens it again - same address, fresh clock
    const renewed = await request(app).post(`/api/suppliers/${s._id}/link`).set("Cookie", tamar).send({ days: 3 });
    expect(renewed.status).toBe(200);
    expect(await tokenOf(renewed.body.data.supplier)).toBe(t0);
    expect(renewed.body.data.supplier.linkLive).toBe(true);
    expect((await request(app).get(pub(t0))).status).toBe(200);
    // ...or a brand-new address
    const fresh = (await request(app).post(`/api/suppliers/${s._id}/link`).set("Cookie", tamar).send({ days: 3, fresh: true })).body.data.supplier;
    expect(await tokenOf(fresh)).not.toBe(t0);
    expect((await request(app).get(pub(t0))).status).toBe(404);
  });

  it("the form: the starred fields are required, numbers are numbers, the terms are fixed", async () => {
    const s = (await create(tamar)).body.data.supplier;
    const t = await tokenOf(s);
    const missing = await request(app).put(`${pub(t)}/form`).send({ ...GOOD_FORM, contactEmail: "not-an-email", accountNumber: "abc" });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("SUPPLIER_FORM_INVALID");
    expect(missing.body.message).toMatch(/מייל איש קשר/);
    expect(missing.body.message).toMatch(/מספר חשבון/);

    const ok = await request(app).put(`${pub(t)}/form`).send(GOOD_FORM);
    expect(ok.status).toBe(200);
    const v = ok.body.data.view;
    expect(v.status).toBe("filling");
    expect(v.form).toMatchObject({ businessId: "512345678", contactEmail: "ronit@example.org", accountNumber: "123456", paymentTerms: "שוטף + 60" });
    expect(v.form.bank).toMatchObject({ code: 12, name: "בנק הפועלים" });
    expect(v.form.branch).toMatchObject({ code: 600 });
    expect(v.form.address).toMatchObject({ city: "ירושלים", zip: "9153002" });
    const staff = (await request(app).get(`/api/suppliers/${s._id}`).set("Cookie", tamar)).body.data.supplier;
    expect(staff.formSubmittedAt).toBeTruthy();
    expect(staff.updates.map((u) => u.text)).toContain("מילא/ה את הטופס");
  });

  it("the files: PDF / image / Word only, the optional one may be waved, counts and status follow", async () => {
    const s = (await create(tamar)).body.data.supplier;
    const t = await tokenOf(s);
    expect((await upload(t, "junk")).status).toBe(400);
    const mp3 = await upload(t, "books", { fileName: "song.mp3", mime: "audio/mpeg" });
    expect(mp3.status).toBe(400);
    expect(mp3.body.code).toBe("DOCUMENT_INVALID");
    const must = await request(app).post(`${pub(t)}/files/books/not-applicable`).send({ value: true });
    expect(must.status).toBe(400);
    expect(must.body.code).toBe("SUPPLIER_FILE_REQUIRED");

    const one = await upload(t, "books", { thumb: `data:image/png;base64,${PNG.toString("base64")}` });
    expect(one.status).toBe(200);
    expect(one.body.data.view.counts).toMatchObject({ total: 4, done: 1, ok: 0, bad: 0 });
    const row = one.body.data.view.files.find((f) => f.key === "books");
    expect(row).toMatchObject({ fileName: "a.png", mime: "image/png", thumb: true, done: true });
    // the plain links behind the link answer with a signed read of the bucket, the file and its thumbnail
    const file = await request(app).get(`${pub(t)}/files/books/file`);
    expect(file.status).toBe(302);
    expect(file.headers.location).toMatch(/^memory:\/\/get\/suppliers\//);
    expect((await request(app).get(`${pub(t)}/files/books/thumb`)).headers.location).toMatch(/\.thumb\.jpg\?/);
    expect((await request(app).get(`${pub(t)}/files/withholding/file`)).status).toBe(404);

    await request(app).put(`${pub(t)}/form`).send(GOOD_FORM);
    for (const key of ["withholding", "bankProof"]) await upload(t, key);
    const waved = await request(app).post(`${pub(t)}/files/exempt/not-applicable`).send({ value: true });
    expect(waved.body.data.view.counts.done).toBe(4);
    expect(waved.body.data.view.status).toBe("review");
    // pulled back → filling again
    const removed = await request(app).delete(`${pub(t)}/files/bankProof`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.view.status).toBe("filling");
    expect(await StoredFile.countDocuments()).toBe(2);
  });

  it("the supplier's שליחה: refused until everything is in, then stamped with a line for the coordinator; a later change clears it (2026-10-23)", async () => {
    const s = (await create(tamar)).body.data.supplier;
    const t = await tokenOf(s);
    const early = await request(app).post(`${pub(t)}/finish`);
    expect(early.status).toBe(400);
    expect(early.body.code).toBe("SUPPLIER_NOT_COMPLETE");
    await request(app).put(`${pub(t)}/form`).send(GOOD_FORM);
    for (const key of ["books", "withholding", "bankProof"]) await upload(t, key);
    const before = await request(app).get(pub(t));
    expect(before.body.data.view.complete).toBe(false);
    await request(app).post(`${pub(t)}/files/exempt/not-applicable`).send({ value: true });
    const ready = await request(app).get(pub(t));
    expect(ready.body.data.view).toMatchObject({ complete: true, finishedAt: null, status: "review" });
    const sent = await request(app).post(`${pub(t)}/finish`);
    expect(sent.status).toBe(200);
    expect(sent.body.data.view.finishedAt).toBeTruthy();
    expect(sent.body.data.view.status).toBe("review");
    const staff = await request(app).get(`/api/suppliers/${s._id}`).set("Cookie", tamar);
    const sv = staff.body.data.supplier;
    expect(sv.finishedAt).toBeTruthy();
    expect(sv.updates.at(-1)).toMatchObject({ kind: "finish", text: "סיים/ה - הטופס וכל האישורים נשלחו" });
    // a replaced certificate takes the stamp back - the supplier sends again, with a fresh line
    await upload(t, "books");
    expect((await request(app).get(pub(t))).body.data.view.finishedAt).toBeNull();
    const again = await request(app).post(`${pub(t)}/finish`);
    expect(again.body.data.view.finishedAt).toBeTruthy();
    const sv2 = (await request(app).get(`/api/suppliers/${s._id}`).set("Cookie", tamar)).body.data.supplier;
    expect(sv2.updates.at(-1).text).toMatch(/מחדש/);
  });

  it("the coordinator checks every item: לא תקין needs a note (and fields for the form), the supplier fixes, the card gets an unseen update", async () => {
    const { id, token } = await readySupplier();
    expect((await review(tamar, id, { target: "form", state: "bad" })).body.code).toBe("SUPPLIER_REVIEW_NOTE");
    expect((await review(tamar, id, { target: "form", state: "bad", note: "המספר לא נכון" })).body.code).toBe("SUPPLIER_REVIEW_FIELDS");
    const bad = await review(tamar, id, { target: "form", state: "bad", note: "המספר לא נכון", fields: ["businessId", "junk"] });
    expect(bad.status).toBe(200);
    expect(bad.body.data.supplier.status).toBe("filling");
    expect(bad.body.data.supplier.formReview).toMatchObject({ state: "bad", note: "המספר לא נכון", fields: ["businessId"], by: "תמר צימרינג" });
    const badFile = await review(tamar, id, { target: "books", state: "bad", note: "לא קריא" });
    expect(badFile.body.data.supplier.counts).toMatchObject({ done: 4, ok: 0, bad: 1 });

    // the supplier sees why, and fixes both
    await request(app).post(`/api/suppliers/${id}/seen`).set("Cookie", tamar);
    const view = (await request(app).get(pub(token))).body.data.view;
    expect(view.formReview).toMatchObject({ state: "bad", fields: ["businessId"] });
    expect(view.files.find((f) => f.key === "books").review).toMatchObject({ state: "bad", note: "לא קריא" });
    expect((await request(app).put(`${pub(token)}/form`).send({ ...GOOD_FORM, businessId: "512345679" })).body.data.view.formReview.state).toBe("pending");
    const fixed = await upload(token, "books");
    expect(fixed.body.data.view.status).toBe("review");
    const staff = (await request(app).get(`/api/suppliers/${id}`).set("Cookie", tamar)).body.data.supplier;
    // the first opening of the link counts too (the GET above was the supplier's first look)
    expect(staff.unseen).toBe(3);
    expect(staff.updates.filter((u) => !u.seenAt).map((u) => u.text)).toEqual(["פתח/ה את הקישור", "תיקן/ה את הטופס", "העלה/תה מחדש אישור ניהול ספרים"]);
    const seen = await request(app).post(`/api/suppliers/${id}/seen`).set("Cookie", tamar);
    expect(seen.body.data.supplier.unseen).toBe(0);
  });

  it("everything תקין → approved; the mail needs the PDF and both copies first; sent → done and locked", async () => {
    const { id, token } = await readySupplier();
    const early = await email(tamar, id, { step: "pdf" });
    expect(early.status).toBe(400);
    expect(early.body.code).toBe("SUPPLIER_NOT_APPROVED");
    for (const target of ["form", "books", "withholding", "bankProof", "exempt"]) expect((await review(tamar, id, { target, state: "ok" })).status).toBe(200);
    let s = (await request(app).get(`/api/suppliers/${id}`).set("Cookie", tamar)).body.data.supplier;
    expect(s.status).toBe("approved");
    expect(s.counts).toMatchObject({ ok: 4, bad: 0 });
    // an approved file and form are locked for the supplier
    expect((await upload(token, "books")).body.code).toBe("SUPPLIER_FILE_LOCKED");
    expect((await request(app).put(`${pub(token)}/form`).send(GOOD_FORM)).body.code).toBe("SUPPLIER_FORM_LOCKED");

    const tooSoon = await email(tamar, id, { step: "sent" });
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.code).toBe("SUPPLIER_EMAIL_STEPS");
    expect((await email(tamar, id, { step: "pdf" })).status).toBe(200);
    expect((await email(tamar, id, { step: "subject" })).status).toBe(200);
    const body = await email(tamar, id, { step: "body", to: { name: "מיכל", gender: "female" } });
    expect(body.body.data.supplier.email.to).toMatchObject({ name: "מיכל", gender: "female" });
    const sent = await email(tamar, id, { step: "sent" });
    expect(sent.status).toBe(200);
    expect(sent.body.data.supplier).toMatchObject({ status: "done", statusLabel: "נשלח מייל" });
    expect(sent.body.data.supplier.email.sentBy).toBe("תמר צימרינג");
    expect((await review(tamar, id, { target: "books", state: "bad", note: "x" })).body.code).toBe("SUPPLIER_DONE");
    expect((await request(app).get(pub(token))).body.data.view.done).toBe(true);
  });

  it("the super admin edits statuses and deletes things; the coordinator may not", async () => {
    const { id, token } = await readySupplier();
    const admin = (body, cookie = eden) => request(app).post(`/api/suppliers/${id}/admin`).set("Cookie", cookie).send(body);
    expect((await admin({ action: "reviewSet", target: "form", state: "ok" }, tamar)).status).toBe(403);
    expect((await admin({ action: "nope" })).body.code).toBe("SUPPLIER_ADMIN_ACTION");
    // statuses: every item ok → approved; one back to pending → review
    for (const target of ["form", "books", "withholding", "bankProof", "exempt"]) expect((await admin({ action: "reviewSet", target, state: "ok" })).status).toBe(200);
    let s = (await request(app).get(`/api/suppliers/${id}`).set("Cookie", tamar)).body.data.supplier;
    expect(s.status).toBe("approved");
    s = (await admin({ action: "reviewSet", target: "books", state: "pending" })).body.data.supplier;
    expect(s.status).toBe("review");
    expect(s.fileRows.find((r) => r.key === "books").review.state).toBe("pending");
    // the mail: sent forced without the three steps → done; sent undone → back
    s = (await admin({ action: "reviewSet", target: "books", state: "ok" })).body.data.supplier;
    s = (await admin({ action: "emailSet", step: "sent", on: true })).body.data.supplier;
    expect(s.status).toBe("done");
    expect(s.email.sentBy).toBe("עדן כהן");
    s = (await admin({ action: "emailSet", step: "sent", on: false })).body.data.supplier;
    expect(s.status).toBe("approved");
    expect(s.email.sentAt).toBeFalsy();
    s = (await admin({ action: "emailSet", step: "pdf", on: true })).body.data.supplier;
    expect(s.email.pdfAt).toBeTruthy();
    // everything the coordinator pressed, undone in one go: verdicts pending, mail steps off; the supplier's work stays
    expect((await admin({ action: "reviewSet", target: "form", state: "bad", note: "x", value: ["businessId"] })).status).toBe(200);
    s = (await admin({ action: "coordinatorReset" })).body.data.supplier;
    expect(s.formReview.state).toBe("pending");
    expect(s.fileRows.every((r) => r.review.state === "pending")).toBe(true);
    expect(s.email.pdfAt).toBeFalsy();
    expect(s.email.sentAt).toBeFalsy();
    expect(s.status).toBe("review");
    expect(s.counts.done).toBe(4);
    expect(s.formSubmittedAt).toBeTruthy();
    // delete a file, wave the fourth off, reset the form, clear the feed, close the link
    s = (await admin({ action: "fileRemove", key: "bankProof" })).body.data.supplier;
    expect(s.fileRows.find((r) => r.key === "bankProof").fileName).toBeNull();
    expect(s.status).toBe("filling");
    expect(await StoredFile.countDocuments()).toBe(2);
    s = (await admin({ action: "waive", key: "exempt", value: false })).body.data.supplier;
    expect(s.fileRows.find((r) => r.key === "exempt").notApplicable).toBe(false);
    s = (await admin({ action: "formReset" })).body.data.supplier;
    expect(s.formSubmittedAt).toBeFalsy();
    expect(s.status).toBe("link");
    s = (await admin({ action: "updatesClear" })).body.data.supplier;
    expect(s.updates).toHaveLength(0);
    s = (await admin({ action: "linkClose" })).body.data.supplier;
    expect(s.linkLive).toBe(false);
    expect((await request(app).get(pub(token))).status).toBe(410);
  });

  it("deleting a supplier takes its stored files with it", async () => {
    const { id } = await readySupplier();
    expect(await StoredFile.countDocuments()).toBe(3);
    expect((await request(app).delete(`/api/suppliers/${id}`).set("Cookie", tamar)).status).toBe(204);
    expect(await Supplier.findById(id)).toBeNull();
    expect(await StoredFile.countDocuments()).toBe(0);
  });
});
