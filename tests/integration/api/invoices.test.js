/**
 * חשבוניות של מורים - a picture + the lessons written on it. The rules:
 * at least one lesson, only the teacher's own lessons (the cycle's teacher
 * or the substitute written on the lesson), a lesson billed once, the
 * picture validated and served back, removal frees the lessons, worlds
 * stay apart.
 */

const request = require("supertest");
const app = require("../../../app");
const Invoice = require("../../../models/Invoice");
const InvoiceLesson = require("../../../models/InvoiceLesson");
const StoredFile = require("../../../models/StoredFile");
const { makeTeacher, makeStudent, makeCycle, makeLesson } = require("../../helpers/factories");

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMAGE = `data:image/png;base64,${PNG_B64}`;

/** A teacher with a cycle and `n` lessons of it. */
async function teacherWithLessons(n = 2, world = "real") {
  const teacher = await makeTeacher({ world });
  const cycle = await makeCycle({ teacher: teacher._id, world });
  const lessons = [];
  for (let i = 0; i < n; i++) lessons.push(await makeLesson({ cycle: cycle._id, world, date: new Date(`2026-03-${10 + i}T00:00:00.000Z`) }));
  return { teacher, cycle, lessons };
}

const post = (body, world) => {
  const r = request(app).post("/api/invoices").send(body);
  return world ? r.set("X-Dataset", world) : r;
};

describe("POST /api/invoices", () => {
  it("creates an invoice: the picture is stored, the lessons are rows, the answer carries them", async () => {
    const { teacher, lessons } = await teacherWithLessons(2);
    const res = await post({ teacher: teacher._id, lessons: lessons.map((l) => l._id), imageData: IMAGE, imageName: "march.png", by: "נעה", note: "מרץ" });
    expect(res.status).toBe(201);
    const inv = res.body.data.invoice;
    expect(String(inv.teacher)).toBe(String(teacher._id));
    expect(inv.lessons.map((l) => String(l._id)).sort()).toEqual(lessons.map((l) => String(l._id)).sort());
    expect(inv.lessons[0].cycle).toBeDefined();
    expect(inv.file).toMatchObject({ mime: "image/png", name: "march.png" });
    expect(inv.file.data).toBeUndefined();
    expect(inv.uploadedBy).toBe("נעה");
    expect(await InvoiceLesson.countDocuments({ invoice: inv._id })).toBe(2);
    expect(await StoredFile.countDocuments()).toBe(1);
  });

  it("refuses an invoice without lessons", async () => {
    const { teacher } = await teacherWithLessons(1);
    const res = await post({ teacher: teacher._id, lessons: [], imageData: IMAGE });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVOICE_NO_LESSONS");
    expect(await Invoice.countDocuments()).toBe(0);
    expect(await StoredFile.countDocuments()).toBe(0);
  });

  it("refuses a lesson of another teacher", async () => {
    const { teacher } = await teacherWithLessons(1);
    const other = await teacherWithLessons(1);
    const res = await post({ teacher: teacher._id, lessons: [other.lessons[0]._id], imageData: IMAGE });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVOICE_LESSON_NOT_TEACHERS");
  });

  it("accepts a lesson the teacher gave as a substitute", async () => {
    const { teacher } = await teacherWithLessons(0);
    const other = await teacherWithLessons(0);
    const sub = await makeLesson({ cycle: other.cycle._id, teacher: teacher._id });
    const res = await post({ teacher: teacher._id, lessons: [sub._id], imageData: IMAGE });
    expect(res.status).toBe(201);
    // …and the cycle's teacher cannot bill that lesson
    const res2 = await post({ teacher: other.teacher._id, lessons: [sub._id], imageData: IMAGE });
    expect(res2.status).toBe(400);
    expect(res2.body.code).toBe("INVOICE_LESSON_NOT_TEACHERS");
  });

  it("bills a lesson once - a second invoice naming it is refused and leaves nothing behind", async () => {
    const { teacher, lessons } = await teacherWithLessons(2);
    expect((await post({ teacher: teacher._id, lessons: [lessons[0]._id], imageData: IMAGE })).status).toBe(201);
    const res = await post({ teacher: teacher._id, lessons: [lessons[1]._id, lessons[0]._id], imageData: IMAGE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVOICE_LESSON_BILLED");
    expect(await Invoice.countDocuments()).toBe(1);
    expect(await StoredFile.countDocuments()).toBe(1);
    expect(await InvoiceLesson.countDocuments()).toBe(1);
  });

  it("refuses a picture that is not an image, or no picture", async () => {
    const { teacher, lessons } = await teacherWithLessons(1);
    const body = { teacher: teacher._id, lessons: [lessons[0]._id] };
    expect((await post({ ...body, imageData: "data:application/pdf;base64,AAAA" })).body.code).toBe("INVOICE_IMAGE_INVALID");
    expect((await post({ ...body, imageData: "hello" })).body.code).toBe("INVOICE_IMAGE_INVALID");
    expect((await post(body)).status).toBe(400);
  });

  it("refuses a person who is not an active teacher", async () => {
    const student = await makeStudent();
    const { lessons } = await teacherWithLessons(1);
    const res = await post({ teacher: student._id, lessons: [lessons[0]._id], imageData: IMAGE });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVOICE_NOT_A_TEACHER");
  });
});

describe("reading invoices", () => {
  it("lists a teacher's invoices newest first, serves the picture, lists the lessons they may bill", async () => {
    const { teacher, lessons } = await teacherWithLessons(3);
    const a = (await post({ teacher: teacher._id, lessons: [lessons[0]._id], imageData: IMAGE })).body.data.invoice;
    await Invoice.updateOne({ _id: a._id }, { uploadedAt: new Date("2026-01-01") });
    const b = (await post({ teacher: teacher._id, lessons: [lessons[1]._id], imageData: IMAGE })).body.data.invoice;

    const list = await request(app).get(`/api/invoices?teacher=${teacher._id}`);
    expect(list.status).toBe(200);
    expect(list.body.data.invoices.map((i) => i._id)).toEqual([b._id, a._id]);

    const img = await request(app).get(`/api/invoices/${a._id}/image`);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toMatch(/image\/png/);
    expect(img.body.length).toBe(Buffer.from(PNG_B64, "base64").length);

    const mine = await request(app).get(`/api/invoices/lessons?teacher=${teacher._id}`);
    expect(mine.status).toBe(200);
    const byId = Object.fromEntries(mine.body.data.lessons.map((l) => [String(l._id), l.invoice]));
    expect(Object.keys(byId)).toHaveLength(3);
    expect(byId[String(lessons[0]._id)]).toBe(a._id);
    expect(byId[String(lessons[1]._id)]).toBe(b._id);
    expect(byId[String(lessons[2]._id)]).toBeNull();
  });

  it("keeps worlds apart", async () => {
    const t = await teacherWithLessons(1, "test");
    const res = await post({ teacher: t.teacher._id, lessons: [t.lessons[0]._id], imageData: IMAGE }, "test");
    expect(res.status).toBe(201);
    expect((await request(app).get(`/api/invoices?teacher=${t.teacher._id}`)).body.data.invoices).toHaveLength(0);
    expect((await request(app).get(`/api/invoices/${res.body.data.invoice._id}`)).status).toBe(404);
    expect((await request(app).get(`/api/invoices/${res.body.data.invoice._id}`).set("X-Dataset", "test")).status).toBe(200);
    // a lesson of the real world cannot be billed from the test world
    const real = await teacherWithLessons(1);
    expect((await post({ teacher: real.teacher._id, lessons: [real.lessons[0]._id], imageData: IMAGE }, "test")).status).toBe(400);
  });
});

describe("changing and removing", () => {
  it("replaces the lessons (never to none) and the note", async () => {
    const { teacher, lessons } = await teacherWithLessons(3);
    const inv = (await post({ teacher: teacher._id, lessons: [lessons[0]._id, lessons[1]._id], imageData: IMAGE })).body.data.invoice;
    const res = await request(app).patch(`/api/invoices/${inv._id}`).send({ lessons: [lessons[1]._id, lessons[2]._id], note: "תוקן" });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice.lessons.map((l) => String(l._id)).sort()).toEqual([lessons[1]._id, lessons[2]._id].map(String).sort());
    expect(res.body.data.invoice.note).toBe("תוקן");
    expect((await request(app).patch(`/api/invoices/${inv._id}`).send({ lessons: [] })).body.code).toBe("INVOICE_NO_LESSONS");
    // lesson 0 is free again: another invoice may name it
    expect((await post({ teacher: teacher._id, lessons: [lessons[0]._id], imageData: IMAGE })).status).toBe(201);
    // …and now it cannot be taken back
    const back = await request(app).patch(`/api/invoices/${inv._id}`).send({ lessons: [lessons[0]._id, lessons[1]._id] });
    expect(back.status).toBe(409);
    expect((await InvoiceLesson.find({ invoice: inv._id })).map((r) => String(r.lesson)).sort()).toEqual([lessons[1]._id, lessons[2]._id].map(String).sort());
  });

  it("removes an invoice with its rows and its picture, freeing the lessons", async () => {
    const { teacher, lessons } = await teacherWithLessons(1);
    const inv = (await post({ teacher: teacher._id, lessons: [lessons[0]._id], imageData: IMAGE })).body.data.invoice;
    expect((await request(app).delete(`/api/invoices/${inv._id}`)).status).toBe(204);
    expect(await Invoice.countDocuments()).toBe(0);
    expect(await InvoiceLesson.countDocuments()).toBe(0);
    expect(await StoredFile.countDocuments()).toBe(0);
    expect((await post({ teacher: teacher._id, lessons: [lessons[0]._id], imageData: IMAGE })).status).toBe(201);
    expect((await request(app).delete(`/api/invoices/${inv._id}`)).status).toBe(404);
  });
});
