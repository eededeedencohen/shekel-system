/**
 * @file Invoice controller — /api/invoices (חשבוניות של מורים)
 * @module controllers/invoiceController
 *
 *   GET    /lessons?teacher=      the lessons a teacher may bill (+ which are billed)
 *   GET    /?teacher=             the invoices (of one teacher, or all)
 *   POST   /                      { teacher*, lessons*[], imageData*, imageName, by, note }
 *   GET    /:id                   one invoice
 *   GET    /:id/image             the picture itself
 *   PATCH  /:id                   { lessons?[], note? }
 *   DELETE /:id
 *
 * Every rule lives in services/invoiceService.
 */

const catchAsync = require("../utils/catchAsync");
const invoices = require("../services/invoiceService");

exports.getTeacherLessons = catchAsync(async (req, res) => {
  const lessons = await invoices.lessonsOfTeacher({ world: req.world, teacherId: req.query.teacher });
  res.status(200).json({ status: "success", results: lessons.length, data: { lessons } });
});

exports.getInvoices = catchAsync(async (req, res) => {
  const list = await invoices.listInvoices({ world: req.world, teacherId: req.query.teacher });
  res.status(200).json({ status: "success", results: list.length, data: { invoices: list } });
});

exports.getInvoice = catchAsync(async (req, res) => {
  const invoice = await invoices.getInvoice({ world: req.world, invoiceId: req.params.id });
  res.status(200).json({ status: "success", data: { invoice } });
});

exports.createInvoice = catchAsync(async (req, res) => {
  const invoice = await invoices.createInvoice({
    world: req.world,
    teacherId: req.body.teacher,
    lessonIds: req.body.lessons,
    imageData: req.body.imageData,
    imageName: req.body.imageName,
    by: req.body.by,
    note: req.body.note,
  });
  res.status(201).json({ status: "success", data: { invoice } });
});

exports.updateInvoice = catchAsync(async (req, res) => {
  const invoice = await invoices.updateInvoice({ world: req.world, invoiceId: req.params.id, lessonIds: req.body.lessons, note: req.body.note });
  res.status(200).json({ status: "success", data: { invoice } });
});

exports.deleteInvoice = catchAsync(async (req, res) => {
  await invoices.deleteInvoice({ world: req.world, invoiceId: req.params.id });
  res.status(204).json({ status: "success", data: null });
});

/** The stored picture, inline (a plain link the browser may open in a tab). */
exports.getImage = catchAsync(async (req, res) => {
  const file = await invoices.imageOf({ world: req.world, invoiceId: req.params.id });
  res.set("Cache-Control", "private, max-age=86400");
  res.type(file.mime);
  res.send(file.data);
});
