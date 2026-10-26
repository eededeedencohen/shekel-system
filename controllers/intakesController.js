/**
 * @file Intakes controller - the social worker's board (קליטה / אינטייק)
 * @module controllers/intakesController
 *
 * Reads and writes the `intakes` records (one per person) and lets the
 * staff drive the flow: the first call's facts, the coordinator who owns
 * the file, the meeting, "בוצע אינטייק" with the intake template, the
 * documents with their validity, the admission in שקדיה, the committee
 * date, temporary upload links. Every transition goes through
 * services/intakeService, which also moves the student profiles.
 *
 * `by` is the acting persona's name (no auth yet), like every other
 * pipeline write.
 */

const Intake = require("../models/Intake");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { byOf } = require("../utils/actor");
const { linkAnswer } = require("../utils/publicUrl");
const intake = require("../services/intakeService");
const lens = require("../services/lensService");
const storedFiles = require("../services/storedFiles");

const PERSON_POP = { path: "person", select: "firstName lastName phone email gender birthDate avatar deletedAt" };
const SUBJECT_POP = { path: "landing.preferences.subjects", select: "name category" };

async function load(req) {
  const doc = await Intake.findOne({ _id: req.params.id });
  if (!doc) throw AppError.of("NOT_FOUND", 404, "תיק קליטה");
  return doc;
}
const populated = (doc) => Intake.findById(doc._id).populate([PERSON_POP, SUBJECT_POP]);
const personOf = async (req, id) => {
  const person = await Person.findOne({ _id: id, deletedAt: null });
  if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
  await lens.assertPerson(req, person._id); // the acting persona's own people (lensService)
  return person;
};

/** GET /api/intakes?status=&person= */
exports.getIntakes = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = { $in: req.query.status.split(",") };
  if (req.query.person) filter.person = req.query.person;
  await lens.narrowByPerson(req, filter, "person"); // the files of the lens's people only
  const intakes = await Intake.find(filter).populate([PERSON_POP, SUBJECT_POP]).sort({ updatedAt: -1 });
  res.status(200).json({ status: "success", results: intakes.length, data: { intakes } });
});

/** GET /api/intakes/:id */
exports.getIntake = catchAsync(async (req, res) => {
  const doc = await load(req);
  res.status(200).json({ status: "success", data: { intake: await populated(doc) } });
});

/** GET /api/intakes/person/:personId - 404 when the person has no record. */
exports.getByPerson = catchAsync(async (req, res, next) => {
  const doc = await Intake.findOne({ person: req.params.personId }).populate([PERSON_POP, SUBJECT_POP]);
  if (!doc) return next(AppError.of("NOT_FOUND", 404, "תיק קליטה"));
  res.status(200).json({ status: "success", data: { intake: doc } });
});

/** POST /api/intakes/open - { person, by }: open a record for a walk-in. */
exports.openIntake = catchAsync(async (req, res) => {
  const person = await personOf(req, req.body.person);
  const doc = await intake.ensureIntake({ person, source: "staff", by: byOf(req) });
  res.status(201).json({ status: "success", data: { intake: await populated(doc) } });
});

/** POST /api/intakes/schedule - { person, at, by, note } (find-or-create + schedule). */
exports.scheduleForPerson = catchAsync(async (req, res) => {
  const person = await personOf(req, req.body.person);
  const doc = await intake.ensureIntake({ person, source: "staff", by: byOf(req) });
  const { moved } = await intake.schedule({ intake: doc, at: req.body.at, by: byOf(req), note: req.body.note });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/**
 * POST /api/intakes/screening - { person, eligibility, interests[], calledAt, by, note }
 * The first call's facts (find-or-create the record) + a "שיחה ראשונית" activity.
 */
exports.screenPerson = catchAsync(async (req, res) => {
  const person = await personOf(req, req.body.person);
  const doc = await intake.ensureIntake({ person, source: "staff", by: byOf(req) });
  const { activity } = await intake.setScreening({
    intake: doc,
    eligibility: req.body.eligibility,
    interests: req.body.interests,
    calledAt: req.body.calledAt,
    by: byOf(req),
    note: req.body.note,
  });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), activity } });
});

/** POST /api/intakes/:id/schedule - { at, by, note } (re)schedule. */
exports.reschedule = catchAsync(async (req, res) => {
  const doc = await load(req);
  const { moved } = await intake.schedule({ intake: doc, at: req.body.at, by: byOf(req), note: req.body.note });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/** POST /api/intakes/:id/done - { at?, by, waiverSigned, summary, fields{background, expectations, goals, treating} } */
exports.markDone = catchAsync(async (req, res) => {
  const doc = await load(req);
  const { moved, activity } = await intake.markDone({
    intake: doc,
    at: req.body.at,
    by: byOf(req),
    waiverSigned: req.body.waiverSigned === true || req.body.waiverSigned === "true",
    summary: req.body.summary,
    fields: req.body.fields,
  });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved, activity } });
});

/**
 * PATCH /api/intakes/:id/documents/:key - { status, by, note, validUntil, signedAt }
 * status ∈ received (a dated document needs `validUntil`; a signed one
 * takes `signedAt`) | waived | rejected | missing (delete) | comment (a
 * reply the student sees; the status stays).
 */
exports.setDocument = catchAsync(async (req, res) => {
  const doc = await load(req);
  const { moved } = await intake.setDocumentStatus({
    intake: doc,
    key: req.params.key,
    status: req.body.status,
    by: byOf(req),
    note: req.body.note,
    validUntil: req.body.validUntil,
    signedAt: req.body.signedAt,
  });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/** POST /api/intakes/:id/documents - { key, fileName, mime, data(base64), by, validUntil?, signedAt? } (staff upload = received). */
exports.uploadDocument = catchAsync(async (req, res, next) => {
  const doc = await load(req);
  const { key, fileName, mime, data, thumb, validUntil, signedAt } = req.body || {};
  if (!key || !data) return next(AppError.of("MISSING_FIELDS", 400, "key, data"));
  const { moved } = await intake.uploadDocument({ intake: doc, key, fileName, mime, data, thumb, by: byOf(req), staff: true, validUntil, signedAt });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/** GET /api/intakes/:id/documents/:key/file - a plain link to the stored file: a 302 to a signed read of the bucket (services/storedFiles). */
exports.getDocumentFile = catchAsync(async (req, res, next) => {
  const doc = await load(req);
  const row = (doc.documents || []).find((d) => d.key === req.params.key);
  if (!row?.file?.name || !(await storedFiles.redirectIfRemote(req, res, row.file.stored))) return next(AppError.of("NOT_FOUND", 404, "קובץ"));
});

/**
 * POST /api/intakes/:id/waiver - ויתור סודיות signed on the screen:
 * { signedAt?, explained, parties[], witness{}, guardian?{}, signatures{student,witness,guardian?}: PNG data URIs,
 *   document{ fileName, mime, data(base64), thumb? }: the rendered signed page, by }
 * → { intake, moved, waiver, activity }
 */
exports.signWaiver = catchAsync(async (req, res) => {
  const doc = await load(req);
  const b = req.body || {};
  const { moved, waiver, activity } = await intake.signWaiver({
    intake: doc, by: byOf(req), signedAt: b.signedAt, explained: b.explained === true || b.explained === "true",
    parties: b.parties, witness: b.witness, guardian: b.guardian, signatures: b.signatures, document: b.document,
  });
  res.status(201).json({ status: "success", data: { intake: await populated(doc), moved, waiver, activity } });
});

/** GET /api/intakes/:id/waiver - the latest signed waiver (no signature bytes), 404 when none. */
exports.getWaiver = catchAsync(async (req, res, next) => {
  const doc = await load(req);
  const waiver = await intake.waiverOf(doc);
  if (!waiver) return next(AppError.of("NOT_FOUND", 404, "ויתור סודיות"));
  res.status(200).json({ status: "success", data: { waiver } });
});

/** GET /api/intakes/:id/documents/:key/thumb - the thumbnail the uploader rendered: a 302 to the bucket (404 when there is none). */
exports.getDocumentThumb = catchAsync(async (req, res, next) => {
  const doc = await load(req);
  const row = (doc.documents || []).find((d) => d.key === req.params.key);
  if (!row?.file?.thumb || !(await storedFiles.redirectIfRemote(req, res, row.file.stored, { thumb: true }))) return next(AppError.of("NOT_FOUND", 404, "תמונה מוקטנת"));
});

/** PATCH /api/intakes/:id/shkedia - { enteredAt, by, decisionNo, note } or { clear: true, by } */
exports.setShkedia = catchAsync(async (req, res) => {
  const doc = await load(req);
  const { moved } = await intake.setShkedia({
    intake: doc,
    enteredAt: req.body.enteredAt,
    by: byOf(req),
    decisionNo: req.body.decisionNo,
    note: req.body.note,
    clear: req.body.clear === true || req.body.clear === "true",
  });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), moved } });
});

/** PATCH /api/intakes/:id/coordinator - { name, by } (an empty name clears). */
exports.setCoordinator = catchAsync(async (req, res) => {
  const doc = await load(req);
  await intake.setCoordinator({ intake: doc, name: req.body.name, by: byOf(req) });
  res.status(200).json({ status: "success", data: { intake: await populated(doc) } });
});

/** PATCH /api/intakes/:id/screening - { eligibility, interests[], calledAt, by, note } */
exports.setScreening = catchAsync(async (req, res) => {
  const doc = await load(req);
  const { activity } = await intake.setScreening({
    intake: doc,
    eligibility: req.body.eligibility,
    interests: req.body.interests,
    calledAt: req.body.calledAt,
    by: byOf(req),
    note: req.body.note,
  });
  res.status(200).json({ status: "success", data: { intake: await populated(doc), activity } });
});

/** PATCH /api/intakes/:id/committee - { committeeDate, by } (empty clears). */
exports.setCommittee = catchAsync(async (req, res) => {
  const doc = await load(req);
  await intake.setCommitteeDate({ intake: doc, committeeDate: req.body.committeeDate, by: byOf(req) });
  res.status(200).json({ status: "success", data: { intake: await populated(doc) } });
});

/** POST /api/intakes/:id/links - { minutes, docs?[], note? } → the link (its token is made here, never by the browser). */
exports.createLink = catchAsync(async (req, res) => {
  const doc = await load(req);
  const link = await intake.createUploadLink({
    intake: doc,
    minutes: req.body.minutes,
    docs: req.body.docs,
    by: byOf(req),
    note: req.body.note,
  });
  res.status(201).json({ status: "success", data: { link, intake: await populated(doc) } });
});

/** GET /api/intakes/:id/link - the person's personal documents link (the landing page's), whole; its token never rides in the record's JSON (2026-10-26). */
exports.getLink = catchAsync(async (req, res, next) => {
  const doc = await load(req);
  const token = doc.landing?.token;
  if (!token) return next(AppError.of("NOT_FOUND", 404, "קישור אישי"));
  res.set("Cache-Control", "private, no-store");
  res.status(200).json({ status: "success", data: { link: linkAnswer(req, `/join/docs/${token}`, token, doc.landing.linkExpiresAt) } });
});

/** GET /api/intakes/:id/links - every link of the record, newest first. */
exports.getLinks = catchAsync(async (req, res) => {
  const doc = await load(req);
  const links = await intake.linksOf(doc);
  res.status(200).json({ status: "success", results: links.length, data: { links } });
});

/** PATCH /api/intakes/:id - { notes, by } */
exports.updateIntake = catchAsync(async (req, res) => {
  const doc = await load(req);
  await intake.addNote({ intake: doc, by: byOf(req), note: req.body.notes });
  res.status(200).json({ status: "success", data: { intake: await populated(doc) } });
});
