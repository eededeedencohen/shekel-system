/**
 * @file Public controller — the sign-up page (דף הנחיתה), no login
 * @module controllers/publicController
 *
 * Everything under /api/public is reachable WITHOUT a user: the options
 * the page needs to render, the submission itself, and the personal
 * documents link. The world comes from the X-Dataset header like every
 * other route (the page passes `?world=` through), so a demo world can
 * exercise the whole flow without touching real people.
 *
 * Guards (no auth exists yet): a honeypot field, server-side validation,
 * per-file size/type limits, and the personal token as the only key to a
 * record — nothing here reads back other people's data.
 */

const Intake = require("../models/Intake");
const { Person } = require("../models/Person");
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

/** GET /api/public/join/options — everything the page renders from. */
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

/** POST /api/public/join — the submission. */
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

/** The record behind a personal link, or 404. */
async function byToken(req) {
  const token = String(req.params.token || "");
  if (!/^[\w-]{12,64}$/.test(token)) throw AppError.of("INTAKE_LINK_INVALID", 404);
  const doc = await Intake.findOne({ "landing.token": token, world: req.world });
  if (!doc) throw AppError.of("INTAKE_LINK_INVALID", 404);
  const person = await Person.findById(doc.person).select("firstName");
  return { doc, person };
}

/** GET /api/public/join/:token — the student's own documents page. */
exports.viewByToken = catchAsync(async (req, res) => {
  const { doc, person } = await byToken(req);
  res.status(200).json({ status: "success", data: { view: intake.publicView(doc, person) } });
});

/** POST /api/public/join/:token/documents — { key, fileName, mime, data(base64) } */
exports.uploadByToken = catchAsync(async (req, res) => {
  const { doc, person } = await byToken(req);
  const { key, fileName, mime, data } = req.body || {};
  if (!key || !data) throw AppError.of("MISSING_FIELDS", 400, "key, data");
  const { intake: saved } = await intake.uploadDocument({ intake: doc, key, fileName, mime, data, staff: false });
  res.status(200).json({ status: "success", data: { view: intake.publicView(saved, person) } });
});

/** DELETE /api/public/join/:token/documents/:key — pull back an unconfirmed upload. */
exports.removeByToken = catchAsync(async (req, res) => {
  const { doc, person } = await byToken(req);
  const out = await intake.removeStudentDocument({ intake: doc, key: req.params.key });
  const saved = out.intake || out;
  res.status(200).json({ status: "success", data: { view: intake.publicView(saved, person) } });
});
