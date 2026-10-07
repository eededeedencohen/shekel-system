/**
 * @file Public controller - the sign-up page (דף הנחיתה) and the upload links, no login
 * @module controllers/publicController
 *
 * Everything under /api/public is reachable WITHOUT a user: the options
 * the page needs to render, the submission itself, and the documents
 * page behind a link. The world comes from the X-Dataset header like
 * every other route (the page passes `?world=` through), so a demo world
 * can exercise the whole flow without touching real people.
 *
 * A token opens either a temporary upload link the coordinator made
 * (models/UploadLink - alive for the minutes she picked) or the landing
 * page's personal link (alive for a day after the submission). Both lock
 * when their time is over: 410 INTAKE_LINK_EXPIRED, and the page says to
 * ask for a new one.
 *
 * Guards (no auth exists yet): a honeypot field, server-side validation,
 * per-file size/type limits, and the token as the only key to a record -
 * nothing here reads back other people's data.
 */

const Subject = require("../models/Subject");
const Hostel = require("../models/Hostel");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const {
  PROGRAMS,
  INTAKE_DOCUMENTS,
  INTAKE_FILLED_BY,
  EVENT_CATEGORY_GROUPS,
  EVENT_CATEGORIES,
  SUBJECT_CATEGORIES,
  DAY_PARTS,
  HOSTELS,
} = require("../utils/domain");
const intake = require("../services/intakeService");

/** GET /api/public/join/options - everything the page renders from. */
exports.joinOptions = catchAsync(async (req, res) => {
  const [subjects, hostels] = await Promise.all([
    Subject.find({ world: req.world, active: { $ne: false } }).select("name category").sort({ name: 1 }).lean(),
    Hostel.find({ world: req.world, active: { $ne: false } }).select("name").sort({ name: 1 }).lean(),
  ]);
  const hostelNames = hostels.length ? hostels.map((h) => h.name) : HOSTELS;
  res.status(200).json({
    status: "success",
    data: {
      options: {
        world: req.world,
        programs: PROGRAMS,
        subjects,
        subjectCategories: SUBJECT_CATEGORIES,
        eventCategoryGroups: EVENT_CATEGORY_GROUPS,
        eventCategories: EVENT_CATEGORIES,
        documents: INTAKE_DOCUMENTS.filter((d) => d.upload),
        filledBy: INTAKE_FILLED_BY,
        dayParts: DAY_PARTS,
        residences: ["בבית עם המשפחה", "דירה עצמאית בקהילה", "דיור מוגן", ...hostelNames.map((h) => `הוסטל ${h}`), "אחר"],
        maxFileBytes: intake.MAX_FILE_BYTES,
      },
    },
  });
});

/** POST /api/public/join - the submission. */
exports.join = catchAsync(async (req, res) => {
  const out = await intake.submitLanding({ world: req.world, body: req.body || {} });
  res.status(201).json({
    status: "success",
    data: {
      intakeId: out.intake._id,
      token: out.intake.landing.token,
      firstName: out.person.firstName,
      programs: out.profiles,
      personExisted: out.personExisted,
      view: intake.publicView(out.intake, out.person),
    },
  });
});

/** GET /api/public/join/:token - the documents page behind a link. */
exports.viewByToken = catchAsync(async (req, res) => {
  const { intake: doc, person, link } = await intake.resolveToken({ world: req.world, token: req.params.token });
  res.status(200).json({ status: "success", data: { view: intake.publicView(doc, person, link) } });
});

/** POST /api/public/join/:token/documents - { key, fileName, mime, data(base64) } */
exports.uploadByToken = catchAsync(async (req, res) => {
  const { intake: doc, person, link } = await intake.resolveToken({ world: req.world, token: req.params.token });
  const { key, fileName, mime, data } = req.body || {};
  if (!key || !data) throw AppError.of("MISSING_FIELDS", 400, "key, data");
  const { intake: saved } = await intake.uploadDocument({ intake: doc, key, fileName, mime, data, staff: false, link });
  res.status(200).json({ status: "success", data: { view: intake.publicView(saved, person, link) } });
});

/** DELETE /api/public/join/:token/documents/:key - pull back an unconfirmed upload. */
exports.removeByToken = catchAsync(async (req, res) => {
  const { intake: doc, person, link } = await intake.resolveToken({ world: req.world, token: req.params.token });
  const out = await intake.removeStudentDocument({ intake: doc, key: req.params.key });
  const saved = out.intake || out;
  res.status(200).json({ status: "success", data: { view: intake.publicView(saved, person, link) } });
});
