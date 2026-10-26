/**
 * The files bucket (Eden, 2026-10-26): a file is uploaded by the browser
 * straight to the bucket with a signed PUT, the server confirms it against
 * the bucket (HEAD) and hangs it on its record, reads are signed GETs for
 * 60 seconds, the lens decides per file, and a public link may touch its
 * own record alone. The bucket here is services/storage/memoryStorage.
 */

const request = require("supertest");
const app = require("../../../app");
const storage = require("../../../services/storage");
const StoredFile = require("../../../models/StoredFile");
const PersonDocument = require("../../../models/PersonDocument");
const Invoice = require("../../../models/Invoice");
const { makeTeacher, makeStudent, makeCycle, makeLesson } = require("../../helpers/factories");
const { ensureSeedAccounts } = require("../../../services/authService");
const { defaultPasswordFor } = require("../../../utils/password");
const supplierService = require("../../../services/supplierService");
const intakeService = require("../../../services/intakeService");
const { SUPPLIER_FILES } = require("../../../utils/domain");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
afterEach(() => storage.reset());

describe("the files bucket - a signed-in persona", () => {
  it("begin → the browser's PUT → confirm hangs a paper on a person; a signed read; a redirect on the old route; delete", async () => {
    const t = await makeTeacher();
    const begin = await request(app).post("/api/files/upload-url").send({ family: "people", owner: { id: t._id }, name: "סילבוס.png", mime: "image/png", size: PNG.length, thumb: true });
    expect(begin.status).toBe(201);
    const { fileId, put, thumbPut, storageKey } = begin.body.data;
    expect(storageKey).toMatch(new RegExp(`^people/${t._id}/[0-9a-f-]{36}$`));
    expect(put.headers["Content-Type"]).toBe("image/png");
    expect(put.headers["x-amz-tagging"]).toBe("status=pending");
    expect(thumbPut.headers["Content-Type"]).toBe("image/jpeg");
    expect((await StoredFile.findById(fileId).lean()).status).toBe("pending");

    // nothing arrived yet → refused, the row stays pending
    const early = await request(app).post(`/api/files/${fileId}/confirm`).send({ meta: { kind: "syllabus" } });
    expect(early.status).toBe(400);
    expect(early.body.code).toBe("FILE_NOT_UPLOADED");

    await storage.uploadTo(put, PNG);
    await storage.uploadTo(thumbPut, PNG);
    expect(storage.tags(storageKey)).toEqual(["status=pending"]);
    const ok = await request(app).post(`/api/files/${fileId}/confirm`).send({ meta: { kind: "syllabus", label: "סילבוס" } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.attached).toBe(true);
    expect(ok.body.data.document).toMatchObject({ file: fileId, name: "סילבוס.png", mime: "image/png", size: PNG.length, thumb: true, kind: "syllabus", label: "סילבוס", uploadedBy: "בדיקות" });
    const row = await StoredFile.findById(fileId).lean();
    expect(row.status).toBe("ready");
    expect(row.attachedAt).toBeTruthy();
    expect(row.thumbKey).toBe(`${storageKey}.thumb.jpg`);
    expect(row.thumbSize).toBe(PNG.length);
    expect(row.family).toBe("people");
    expect(String(row.owner.id)).toBe(String(t._id));
    expect(row.data).toBeUndefined();
    expect(storage.tags(storageKey)).toEqual([]); // the pending tag went with the attachment

    // the list carries the id, never bytes
    const list = await request(app).get(`/api/people/${t._id}/documents`);
    expect(list.body.data.documents[0].file).toBe(fileId);

    // signed reads: the file, its thumbnail, many at once
    const url = await request(app).get(`/api/files/${fileId}/url`);
    expect(url.status).toBe(200);
    expect(url.body.data).toMatchObject({ legacy: false, mime: "image/png", name: "סילבוס.png", size: PNG.length });
    expect(url.body.data.url).toContain(storageKey);
    expect(new Date(url.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(url.body.data.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 61000);
    expect(url.headers["cache-control"]).toBe("private, no-store");
    const thumbUrl = await request(app).get(`/api/files/${fileId}/url?thumb=1`);
    expect(thumbUrl.body.data.url).toContain(`${storageKey}.thumb.jpg`);
    const many = await request(app).post("/api/files/urls").send({ ids: [fileId, "000000000000000000000000", "nonsense"], thumb: true });
    expect(Object.keys(many.body.data.urls)).toEqual([fileId]);

    // the old content routes answer with a redirect to the bucket
    const docId = ok.body.data.document._id;
    const old = await request(app).get(`/api/people/${t._id}/documents/${docId}/file`);
    expect(old.status).toBe(302);
    expect(old.headers.location).toContain(storageKey);
    expect(old.headers["cache-control"]).toBe("private, no-store");
    const oldThumb = await request(app).get(`/api/people/${t._id}/documents/${docId}/thumb`);
    expect(oldThumb.status).toBe(302);
    expect(oldThumb.headers.location).toContain(".thumb.jpg");

    // a second confirm is refused
    expect((await request(app).post(`/api/files/${fileId}/confirm`).send({})).status).toBe(409);

    // delete goes the family's way: the document row, the file row and the objects are gone
    await request(app).delete(`/api/files/${fileId}`).expect(204);
    expect(await PersonDocument.countDocuments({ person: t._id })).toBe(0);
    expect(await StoredFile.findById(fileId)).toBeNull();
    expect(storage.has(storageKey)).toBe(false);
    expect(storage.has(`${storageKey}.thumb.jpg`)).toBe(false);
  });

  it("the bucket is believed only when it agrees with the declaration; the family's own rules at begin; a pending row can be dropped", async () => {
    const t = await makeTeacher();
    const begin = await request(app).post("/api/files/upload-url").send({ family: "people", owner: { id: t._id }, name: "a.png", mime: "image/png", size: 10 });
    const { fileId, put, storageKey } = begin.body.data;
    await storage.uploadTo(put, PNG); // PNG.length ≠ 10
    const bad = await request(app).post(`/api/files/${fileId}/confirm`).send({});
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("FILE_SIZE_MISMATCH");
    expect(await StoredFile.findById(fileId)).toBeNull();
    expect(storage.has(storageKey)).toBe(false);

    const refuse = (body) => request(app).post("/api/files/upload-url").send(body);
    expect((await refuse({ family: "people", owner: { id: t._id }, name: "x.exe", mime: "application/x-msdownload", size: 10 })).status).toBe(400);
    expect((await refuse({ family: "people", owner: { id: t._id }, name: "x.pdf", mime: "application/pdf", size: 9 * 1024 * 1024 })).body.code).toBe("FILE_TOO_LARGE");
    expect((await refuse({ family: "secrets", owner: { id: t._id }, name: "x.pdf", mime: "application/pdf", size: 10 })).body.code).toBe("FILE_FAMILY_UNKNOWN");
    expect((await refuse({ family: "people", owner: { id: "000000000000000000000000" }, name: "x.pdf", mime: "application/pdf", size: 10 })).status).toBe(404);
    expect((await refuse({ family: "people", owner: { id: t._id }, name: "x.pdf", mime: "application/pdf", size: 0 })).status).toBe(400);
    // a thumbnail bigger than 256KB is dropped, the file itself kept
    const b3 = await request(app).post("/api/files/upload-url").send({ family: "people", owner: { id: t._id }, name: "c.pdf", mime: "application/pdf", size: PDF.length, thumb: true });
    await storage.uploadTo(b3.body.data.put, PDF);
    await storage.uploadTo(b3.body.data.thumbPut, Buffer.alloc(300 * 1024, 1));
    const ok3 = await request(app).post(`/api/files/${b3.body.data.fileId}/confirm`).send({ meta: { kind: "other" } });
    expect(ok3.status).toBe(200);
    expect(ok3.body.data.document.thumb).toBe(false);
    expect((await StoredFile.findById(b3.body.data.fileId).lean()).thumbKey).toBeUndefined();
    expect((await request(app).get(`/api/files/${b3.body.data.fileId}/url?thumb=1`)).status).toBe(404);
    // a Word file is a download, not inline
    const b4 = await request(app).post("/api/files/upload-url").send({ family: "people", owner: { id: t._id }, name: "מכתב.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 12 });
    await storage.uploadTo(b4.body.data.put, Buffer.alloc(12, 2));
    await request(app).post(`/api/files/${b4.body.data.fileId}/confirm`).send({ meta: { kind: "other" } }).expect(200);
    expect((await request(app).get(`/api/files/${b4.body.data.fileId}/url`)).body.data.url).toContain("inline=0");

    // a pending row the browser never finished can be dropped
    const b2 = await request(app).post("/api/files/upload-url").send({ family: "people", owner: { id: t._id }, name: "b.png", mime: "image/png", size: PNG.length });
    await request(app).delete(`/api/files/${b2.body.data.fileId}`).expect(204);
    expect(await StoredFile.findById(b2.body.data.fileId)).toBeNull();
  });

  it("an invoice: the picture in the bucket, the invoice row and its lessons as before; delete takes the objects too", async () => {
    const t = await makeTeacher();
    const cycle = await makeCycle({ teacher: t._id });
    const lesson = await makeLesson({ cycle: cycle._id });
    const begin = await request(app).post("/api/files/upload-url").send({ family: "invoices", owner: { id: t._id }, name: "חשבונית.pdf", mime: "application/pdf", size: PDF.length });
    expect(begin.status).toBe(201);
    const { fileId, put, storageKey } = begin.body.data;
    expect(storageKey.startsWith(`invoices/${t._id}/`)).toBe(true);
    await storage.uploadTo(put, PDF);
    const ok = await request(app).post(`/api/files/${fileId}/confirm`).send({ meta: { lessons: [String(lesson._id)], note: "מרץ" } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.invoice.file._id).toBe(fileId);
    expect(ok.body.data.invoice.lessons).toHaveLength(1);
    expect(ok.body.data.invoice.file.thumb).toBe(false);
    const row = await StoredFile.findById(fileId).lean();
    expect(row.owner.kind).toBe("invoice");
    expect(String(row.owner.id)).toBe(String(ok.body.data.invoice._id));
    // the list read of invoices never pulls bytes and says there is no thumbnail
    const list = await request(app).get(`/api/invoices?teacher=${t._id}`);
    expect(list.body.data.invoices[0].file).toMatchObject({ _id: fileId, thumb: false });
    // the old image route redirects to the picture itself even for ?thumb=1 (no thumbnail to serve)
    const img = await request(app).get(`/api/invoices/${ok.body.data.invoice._id}/image?thumb=1`);
    expect(img.status).toBe(302);
    expect(img.headers.location).toContain(storageKey);
    await request(app).delete(`/api/files/${fileId}`).expect(204);
    expect(await Invoice.countDocuments({ teacher: t._id })).toBe(0);
    expect(storage.has(storageKey)).toBe(false);
  });

  it("a legacy file (bytes still in the database) is read through the app's own route, under the same access check", async () => {
    const t = await makeTeacher();
    const legacy = await request(app).post(`/api/people/${t._id}/documents`).send({ kind: "other", fileName: "ישן.png", mime: "image/png", data: PNG.toString("base64") });
    expect(legacy.status).toBe(201);
    const fileId = legacy.body.data.document.file;
    const url = await request(app).get(`/api/files/${fileId}/url`);
    expect(url.body.data).toMatchObject({ legacy: true, url: `/api/files/${fileId}/bytes`, mime: "image/png" });
    const bytes = await request(app).get(`/api/files/${fileId}/bytes`);
    expect(bytes.status).toBe(200);
    expect(bytes.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.compare(bytes.body, PNG)).toBe(0);
    // the old route still streams it (no storageKey → no redirect)
    expect((await request(app).get(`/api/people/${t._id}/documents/${legacy.body.data.document._id}/file`)).status).toBe(200);
    // the explorer shows the row without its bytes
    const db = await request(app).get(`/api/db/files/${fileId}`);
    expect(db.status).toBe(200);
    expect(db.body.data.doc.data).toBeUndefined();
    expect(db.body.data.doc.mime).toBe("image/png");
  });

  it("GET /api/db/storage says how full the database and the bucket are", async () => {
    const t = await makeTeacher();
    const begin = await request(app).post("/api/files/upload-url").send({ family: "people", owner: { id: t._id }, name: "a.png", mime: "image/png", size: PNG.length });
    await storage.uploadTo(begin.body.data.put, PNG);
    await request(app).post(`/api/files/${begin.body.data.fileId}/confirm`).send({ meta: { kind: "other" } }).expect(200);
    const res = await request(app).get("/api/db/storage?fresh=1");
    expect(res.status).toBe(200);
    const { storage: s } = res.body.data;
    expect(s.mongo.limitBytes).toBe(512 * 1024 * 1024);
    expect(s.mongo.usedBytes).toBeGreaterThan(0);
    expect(s.mongo.collections.some((c) => c.name === "files")).toBe(true);
    expect(s.bucket.usedBytes).toBe(PNG.length);
    expect(s.bucket.files).toBe(1);
    expect(s.bucket.byFamily).toEqual([{ family: "people", files: 1, bytes: PNG.length, pending: 0 }]);
    expect(s.legacyInMongo.files).toBe(0);
  });
});

describe("the files bucket - the lens decides per file", () => {
  beforeAll(() => {
    process.env.AUTH_ENFORCE = "1";
  });
  afterAll(() => {
    delete process.env.AUTH_ENFORCE;
  });
  const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  const signIn = async (username) => cookieOf(await request(app).post("/api/auth/login").send({ username, password: defaultPasswordFor(username) }));

  it("the hostels coordinator reads a teacher's paper (shared staff) and not a college student's; uploads and deletes follow the same line", async () => {
    await ensureSeedAccounts();
    const eden = await signIn("eden");
    const tamar = await signIn("tamar");
    const T = await makeTeacher();
    const A = await makeStudent();
    const up = async (person) => {
      const b = await request(app).post("/api/files/upload-url").set("Cookie", eden).send({ family: "people", owner: { id: person._id }, name: "p.png", mime: "image/png", size: PNG.length });
      expect(b.status).toBe(201);
      await storage.uploadTo(b.body.data.put, PNG);
      const ok = await request(app).post(`/api/files/${b.body.data.fileId}/confirm`).set("Cookie", eden).send({ meta: { kind: "other" } });
      expect(ok.status).toBe(200);
      expect(ok.body.data.document.uploadedBy).toBe("עדן כהן");
      return b.body.data.fileId;
    };
    const fT = await up(T);
    const fA = await up(A);
    expect((await request(app).get(`/api/files/${fT}/url`).set("Cookie", tamar)).status).toBe(200);
    const refused = await request(app).get(`/api/files/${fA}/url`).set("Cookie", tamar);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("OUT_OF_SCOPE");
    const many = await request(app).post("/api/files/urls").set("Cookie", tamar).send({ ids: [fT, fA] });
    expect(Object.keys(many.body.data.urls)).toEqual([fT]);
    expect((await request(app).get(`/api/files/${fA}/bytes`).set("Cookie", tamar)).status).toBe(403);
    expect((await request(app).post("/api/files/upload-url").set("Cookie", tamar).send({ family: "people", owner: { id: A._id }, name: "p.png", mime: "image/png", size: 5 })).status).toBe(403);
    expect((await request(app).delete(`/api/files/${fA}`).set("Cookie", tamar)).status).toBe(403);
    expect((await request(app).delete(`/api/files/${fT}`).set("Cookie", tamar)).status).toBe(204);
    // the library is the super admin's alone; the culture family is not hers either
    expect((await request(app).post("/api/files/upload-url").set("Cookie", tamar).send({ family: "library", owner: {}, name: "c.jpg", mime: "image/jpeg", size: 5 })).status).toBe(403);
    expect((await request(app).post("/api/files/upload-url").set("Cookie", tamar).send({ family: "culture", owner: {}, name: "c.jpg", mime: "image/jpeg", size: 5 })).status).toBe(403);
    // signed out: 401
    expect((await request(app).get(`/api/files/${fA}/url`)).status).toBe(401);
    // the super admin viewing as her is her
    expect((await request(app).get(`/api/files/${fA}/url`).set("Cookie", eden).set("X-Acting-As", String((await request(app).get("/api/auth/staff").set("Cookie", eden)).body.data.staff.find((a) => a.kind === "hostels")._id))).status).toBe(403);
  });
});

describe("the files bucket - behind a public link", () => {
  it("the supplier puts a certificate straight in the bucket behind the token, reads it back signed; another slot's lock and a wrong token hold", async () => {
    const s = await supplierService.create({ body: { firstName: "ספק", lastName: "בדיקה", gender: "male", phone: "0500000000" }, by: "בדיקה" });
    const token = s.link.token;
    const key = SUPPLIER_FILES[0].key;
    const begin = await request(app).post(`/api/public/supplier/${token}/upload-url`).send({ key, name: "ניהול ספרים.pdf", mime: "application/pdf", size: PDF.length, thumb: true });
    expect(begin.status).toBe(201);
    const { fileId, put, thumbPut, storageKey } = begin.body.data;
    expect(storageKey.startsWith(`suppliers/${s._id}/`)).toBe(true);
    await storage.uploadTo(put, PDF);
    await storage.uploadTo(thumbPut, PNG);
    const ok = await request(app).post(`/api/public/supplier/${token}/uploads/${fileId}/confirm`).send({});
    expect(ok.status).toBe(200);
    const row = ok.body.data.view.files.find((f) => f.key === key);
    expect(row).toMatchObject({ fileId, fileName: "ניהול ספרים.pdf", mime: "application/pdf", size: PDF.length, thumb: true });
    const stored = await StoredFile.findById(fileId).lean();
    expect(stored.uploadedBy.token).toBe("supplier");
    expect(stored.attachedAt).toBeTruthy();
    const url = await request(app).get(`/api/public/supplier/${token}/uploads/${fileId}/url`);
    expect(url.status).toBe(200);
    expect(url.body.data.url).toContain(storageKey);
    // the coordinator's side reads the same file, signed, and the old staff route redirects
    expect((await request(app).get(`/api/files/${fileId}/url`)).status).toBe(200);
    const old = await request(app).get(`/api/suppliers/${s._id}/files/${key}/file`);
    expect(old.status).toBe(302);
    // a wrong token is nothing; a stale token on a confirm is nothing
    expect((await request(app).post(`/api/public/supplier/${token}x/upload-url`).send({ key, name: "a.pdf", mime: "application/pdf", size: 5 })).status).toBe(404);
    expect((await request(app).get(`/api/public/supplier/nope-nope-nope-nope/uploads/${fileId}/url`)).status).toBe(404);
    // replacing the certificate drops the previous objects
    const again = await request(app).post(`/api/public/supplier/${token}/upload-url`).send({ key, name: "שוב.pdf", mime: "application/pdf", size: PDF.length });
    await storage.uploadTo(again.body.data.put, PDF);
    await request(app).post(`/api/public/supplier/${token}/uploads/${again.body.data.fileId}/confirm`).send({}).expect(200);
    expect(await StoredFile.findById(fileId)).toBeNull();
    expect(storage.has(storageKey)).toBe(false);
    expect(storage.has(again.body.data.storageKey)).toBe(true);
    // an approved certificate is locked against the link
    await request(app).post(`/api/suppliers/${s._id}/review`).send({ target: key, state: "ok" }).expect(200);
    expect((await request(app).post(`/api/public/supplier/${token}/upload-url`).send({ key, name: "x.pdf", mime: "application/pdf", size: 5 })).body.code).toBe("SUPPLIER_FILE_LOCKED");
  });

  it("the person behind an intake link puts a document in the bucket; a link narrowed to other documents refuses; the office sees it", async () => {
    const student = await makeStudent();
    const intake = await intakeService.ensureIntake({ person: student, source: "staff", by: "בדיקה" });
    const link = await intakeService.createUploadLink({ intake, minutes: 60, docs: ["psychiatric"], by: "בדיקה" });
    const base = `/api/public/join/${link.token}`;
    const begin = await request(app).post(`${base}/files/upload-url`).send({ key: "psychiatric", name: "אישור.pdf", mime: "application/pdf", size: PDF.length });
    expect(begin.status).toBe(201);
    const { fileId, put, storageKey } = begin.body.data;
    expect(storageKey.startsWith(`intake/${intake._id}/`)).toBe(true);
    await storage.uploadTo(put, PDF);
    const ok = await request(app).post(`${base}/files/${fileId}/confirm`).send({});
    expect(ok.status).toBe(200);
    const doc = ok.body.data.view.documents.find((d) => d.key === "psychiatric");
    expect(doc.status).toBe("uploaded");
    expect(doc).toMatchObject({ fileId, fileName: "אישור.pdf", size: PDF.length });
    expect((await request(app).get(`${base}/files/${fileId}/url`)).body.data.url).toContain(storageKey);
    // a document the link does not open
    expect((await request(app).post(`${base}/files/upload-url`).send({ key: "psychosocial", name: "x.pdf", mime: "application/pdf", size: 5 })).body.code).toBe("DOCUMENT_UNKNOWN");
    // the office: the row points at the bucket, the old route redirects, the signed read works
    const staff = await request(app).get(`/api/intakes/${intake._id}`);
    expect(String(staff.body.data.intake.documents.find((d) => d.key === "psychiatric").file.stored)).toBe(fileId);
    expect((await request(app).get(`/api/intakes/${intake._id}/documents/psychiatric/file`)).status).toBe(302);
    expect((await request(app).get(`/api/files/${fileId}/url`)).status).toBe(200);
    // the office marks it missing: the row, the file and the object go
    await request(app).patch(`/api/intakes/${intake._id}/documents/psychiatric`).send({ status: "missing", by: "בדיקה" }).expect(200);
    expect(await StoredFile.findById(fileId)).toBeNull();
    expect(storage.has(storageKey)).toBe(false);
  });
});
