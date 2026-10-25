/**
 * @file Invoice controller - /api/invoices (חשבוניות של מורים)
 * @module controllers/invoiceController
 *
 *   GET    /lessons?teacher=      the lessons a teacher may bill (+ which are billed)
 *   GET    /?teacher=             the invoices (of one teacher, or all)
 *   POST   /                      { teacher*, lessons*[], imageData* (image or PDF), imageName, thumb, by, note }
 *   GET    /:id                   one invoice
 *   GET    /:id/image[?thumb=1]   the file itself (the small JPEG with thumb=1)
 *   PATCH  /:id                   { lessons?[], note? }
 *   DELETE /:id
 *
 * Every rule lives in services/invoiceService.
 */

const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");
const { notModified } = require("../utils/sendFile");
const invoices = require("../services/invoiceService");
const rounds = require("../services/invoiceRoundService");
const lens = require("../services/lensService");

const isSuper = (req) => req.actor?.kind === "super";

/** The lens's sets for the invoice reads: the people (teachers) and the cycles whose lessons are the persona's. */
const scopeSets = async (req) => {
  const scope = lens.scopeOf(req);
  return { people: await scope.people(), cycleIds: await scope.cycleSet() };
};

exports.getTeacherLessons = catchAsync(async (req, res) => {
  await lens.assertPerson(req, req.query.teacher);
  const { cycleIds } = await scopeSets(req);
  const lessons = await invoices.lessonsOfTeacher({ teacherId: req.query.teacher, cycleIds });
  res.status(200).json({ status: "success", results: lessons.length, data: { lessons } });
});

exports.getInvoices = catchAsync(async (req, res) => {
  const { people, cycleIds } = await scopeSets(req);
  const list = await invoices.listInvoices({ teacherId: req.query.teacher, people, cycleIds });
  res.status(200).json({ status: "success", results: list.length, data: { invoices: list } });
});

exports.getInvoice = catchAsync(async (req, res) => {
  const invoice = await invoices.getInvoice({ invoiceId: req.params.id });
  res.status(200).json({ status: "success", data: { invoice } });
});

exports.createInvoice = catchAsync(async (req, res) => {
  await lens.assertPerson(req, req.body.teacher);
  const { cycleIds } = await scopeSets(req);
  const invoice = await invoices.createInvoice({
    teacherId: req.body.teacher,
    lessonIds: req.body.lessons,
    imageData: req.body.imageData,
    imageName: req.body.imageName,
    thumb: req.body.thumb,
    by: req.body.by,
    note: req.body.note,
    cycleIds,
  });
  res.status(201).json({ status: "success", data: { invoice } });
});

// an invoice that came through a teacher's link (the state machine of 2026-10-22, decision 1): the staff may change or
// delete it only while the teacher's month is open and the mail has not gone; its lessons are what the teacher
// marked and only the super admin moves them (case 17). The super admin is never locked out.
const assertUnlocked = (req, invoice, { lessons = false } = {}) => {
  if (isSuper(req)) return;
  if (invoice.locked) throw AppError.of("INVOICE_LOCKED", 403);
  if (lessons && invoice.viaLink) throw AppError.of("INVOICE_LINK_LESSONS", 403);
};

exports.updateInvoice = catchAsync(async (req, res) => {
  const { cycleIds } = await scopeSets(req);
  assertUnlocked(req, await invoices.getInvoice({ invoiceId: req.params.id }), { lessons: req.body.lessons !== undefined });
  const invoice = await invoices.updateInvoice({ invoiceId: req.params.id, lessonIds: req.body.lessons, note: req.body.note, cycleIds });
  res.status(200).json({ status: "success", data: { invoice } });
});

exports.deleteInvoice = catchAsync(async (req, res) => {
  const current = await invoices.getInvoice({ invoiceId: req.params.id });
  assertUnlocked(req, current);
  await invoices.deleteInvoice({ invoiceId: req.params.id });
  // rule 4: a finished request left with nothing opens again
  if (current.request) await rounds.settleAfterDelete({ requestId: current.request });
  res.status(204).json({ status: "success", data: null });
});

/** The stored file (image or PDF), inline - a plain link the browser may open in a tab; `?thumb=1` the small JPEG. */
exports.getImage = catchAsync(async (req, res) => {
  const file = await invoices.imageOf({ invoiceId: req.params.id, thumb: req.query.thumb === "1" });
  // revalidated every time (utils/sendFile): a replaced picture never shows its old bytes
  if (notModified(req, res, `${file._id}-${file.updatedAt ? new Date(file.updatedAt).getTime() : 0}`)) return;
  res.type(file.mime);
  res.send(file.data);
});
