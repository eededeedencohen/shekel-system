/**
 * @file Intakes controller — the social worker's board (קליטה / אינטייק)
 * @module controllers/intakesController
 *
 * Reads and writes the `intakes` records (one per person) and lets the
 * social worker drive the flow: schedule the meeting, mark it done with
 * the signed waiver, tick documents. Every transition goes through
 * services/intakeService, which also moves the student profiles.
 *
 * `by` is the acting persona's name (no auth yet), like every other
 * pipeline write.
 */

const Intake = require("../models/Intake");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const intake = require("../services/intakeService");

const PERSON_POP = { path: "person", select: "firstName lastName phone email gender birthDate avatar deletedAt" };
const SUBJECT_POP = { path: "landing.preferences.subjects", select: "name category" };

async function load(req) {
  const doc = await Intake.findOne({ _id: req.params.id, world: req.world });
  if (!doc) throw AppError.of("NOT_FOUND", 404, "תיק קליטה");
  return doc;
}
const populated = (doc) => Intake.findById(doc._id).populate([PERSON_POP, SUBJECT_POP]);

/** GET /api/intakes?status=&person= */
exports.getIntakes = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  if (req.query.status) filter.status = { $in: req.query.status.split(",") };
  if (req.query.person) filter.person = req.query.person;
  const intakes = await Intake.find(filter).populate([PERSON_POP, SUBJECT_POP]).sort({ updatedAt: -1 });
  res.status(200).json({ status: "success", results: intakes.length, data: { intakes } });
});

/** GET /api/intakes/:id */
exports.getIntake = catchAsync(async (req, res) => {
  const doc = await load(req);
  res.status(200).json({ status: "success", data: { intake: await populated(doc) } });
});

/** GET /api/intakes/person/:personId — 404 when the person has no record. */
exports.getByPerson = catchAsync(async (req, res, next) => {
  const doc = await Intake.findOne({ world: req.world, person: req.params.personId }).populate([PERSON_POP, SUBJECT_POP]);
  if (!doc) return next(AppError.of("NOT_FOUND", 404, "תיק קליטה"));
  res.status(200).json({ status: "success", data: { intake: doc } });
});

/** POST /api/intakes/open — { person, by }: open a record for a walk-in. */
exports.openIntake = catchAsync(async (req, res, next) => {
  const person = await Person.findOne({ _id: req.body.person, world: req.world, deletedAt: null });
  if (!person) return next(AppError.of("NOT_FOUND", 404, "אדם"));
  const doc = await intake.ensureIntake({ person, world: req.world, source: "staff", by: req.body.by });
  res.status(201).json({ status: "success", data: { intake: await populated(doc) } });
});

/** POST /api/intakes/schedule — { person, at, by, note } (find-or-create + schedule). */
exports.scheduleForPerson = catchAsync(async (req, res, next) => {
  const person = await Person.findOne({ _id: req.body.person, world: req.world, deletedAt: null });
  if (!person) return next(AppError.of("NOT_FOUND", 404, "אדם"));
  const doc = await intake.ensureIntake({ person, world: req.world, source: "staff", by: req.body.by });
  const { moved } = await intake.schedule({ intake: doc, at: req.body.at, by: req.body.by, note: req.body.note });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/** POST /api/intakes/:id/schedule — { at, by, note } (re)schedule. */
exports.reschedule = catchAsync(async (req, res) => {
  const doc = await load(req);
  const { moved } = await intake.schedule({ intake: doc, at: req.body.at, by: req.body.by, note: req.body.note });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/** POST /api/intakes/:id/done — { at?, by, waiverSigned, summary } */
exports.markDone = catchAsync(async (req, res) => {
  const doc = await load(req);
  const { moved } = await intake.markDone({
    intake: doc,
    at: req.body.at,
    by: req.body.by,
    waiverSigned: req.body.waiverSigned === true || req.body.waiverSigned === "true",
    summary: req.body.summary,
  });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/**
 * PATCH /api/intakes/:id/documents/:key — { status, by, note, validUntil }
 * status ∈ received (an approval needs `validUntil`) | waived | rejected |
 * missing (delete) | comment (a reply the student sees; the status stays).
 */
exports.setDocument = catchAsync(async (req, res) => {
  const doc = await load(req);
  const { moved } = await intake.setDocumentStatus({
    intake: doc,
    key: req.params.key,
    status: req.body.status,
    by: req.body.by,
    note: req.body.note,
    validUntil: req.body.validUntil,
  });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/** POST /api/intakes/:id/documents — { key, fileName, mime, data(base64), by, validUntil? } (staff upload = received). */
exports.uploadDocument = catchAsync(async (req, res, next) => {
  const doc = await load(req);
  const { key, fileName, mime, data, by, validUntil } = req.body || {};
  if (!key || !data) return next(AppError.of("MISSING_FIELDS", 400, "key, data"));
  const { moved } = await intake.uploadDocument({ intake: doc, key, fileName, mime, data, by, staff: true, validUntil });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/** GET /api/intakes/:id/documents/:key/file — stream the stored file inline. */
exports.getDocumentFile = catchAsync(async (req, res, next) => {
  const doc = await load(req);
  const row = (doc.documents || []).find((d) => d.key === req.params.key);
  const abs = row ? intake.documentPath(doc, row) : null;
  if (!abs) return next(AppError.of("NOT_FOUND", 404, "קובץ"));
  res.type(row.file.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.file.name || row.file.storedName)}`);
  res.sendFile(abs, (err) => {
    if (err) next(AppError.of("NOT_FOUND", 404, "קובץ"));
  });
});

/** PATCH /api/intakes/:id — { notes, by } */
exports.updateIntake = catchAsync(async (req, res) => {
  const doc = await load(req);
  await intake.addNote({ intake: doc, by: req.body.by, note: req.body.notes });
  res.status(200).json({ status: "success", data: { intake: await populated(doc) } });
});
