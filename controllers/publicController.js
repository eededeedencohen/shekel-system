/**
 * @file Public controller - the sign-up page (דף הנחיתה) and the upload links, no login
 * @module controllers/publicController
 *
 * Everything under /api/public is reachable WITHOUT a user: the options
 * the page needs to render, the submission itself, and the documents
 * page behind a link.
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
  DAY_PARTS,
  HOSTELS,
} = require("../utils/domain");
const intake = require("../services/intakeService");
const { allCategories } = require("../services/subjectCategoryService");
const files = require("../services/fileService");
const storedFiles = require("../services/storedFiles");

/** GET /api/public/join/options - everything the page renders from. */
exports.joinOptions = catchAsync(async (req, res) => {
  const [subjects, hostels, subjectCategories] = await Promise.all([
    Subject.find({ active: { $ne: false } }).select("name category").sort({ name: 1 }).lean(),
    Hostel.find({ active: { $ne: false } }).select("name kind").sort({ name: 1 }).lean(),
    allCategories(),
  ]);
  // "הוסטל ליבא" / "קהילת בית אחווה" - a house named by its kind
  const hostelNames = hostels.length ? hostels.map((h) => `${h.kind === "community" ? "קהילת" : "הוסטל"} ${h.name}`) : HOSTELS.map((h) => `הוסטל ${h}`);
  res.status(200).json({
    status: "success",
    data: {
      options: {
        programs: PROGRAMS,
        subjects,
        subjectCategories,
        eventCategoryGroups: EVENT_CATEGORY_GROUPS,
        eventCategories: EVENT_CATEGORIES,
        documents: INTAKE_DOCUMENTS.filter((d) => d.upload),
        filledBy: INTAKE_FILLED_BY,
        dayParts: DAY_PARTS,
        residences: ["בבית עם המשפחה", "דירה עצמאית בקהילה", "דיור מוגן", ...hostelNames, "אחר"],
        maxFileBytes: intake.MAX_FILE_BYTES,
      },
    },
  });
});

/** POST /api/public/join - the submission. */
exports.join = catchAsync(async (req, res) => {
  const out = await intake.submitLanding({ body: req.body || {} });
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
  const { intake: doc, person, link } = await intake.resolveToken({ token: req.params.token });
  res.status(200).json({ status: "success", data: { view: intake.publicView(doc, person, link) } });
});

/** POST /api/public/join/:token/documents - { key, fileName, mime, data(base64) } */
exports.uploadByToken = catchAsync(async (req, res) => {
  const { intake: doc, person, link } = await intake.resolveToken({ token: req.params.token });
  const { key, fileName, mime, data, thumb } = req.body || {};
  if (!key || !data) throw AppError.of("MISSING_FIELDS", 400, "key, data");
  const { intake: saved } = await intake.uploadDocument({ intake: doc, key, fileName, mime, data, thumb, staff: false, link });
  res.status(200).json({ status: "success", data: { view: intake.publicView(saved, person, link) } });
});

/** The document row a link may show (a temporary link can be narrowed to some documents). */
async function rowForLink(req) {
  const { intake: doc, link } = await intake.resolveToken({ token: req.params.token });
  const key = req.params.key;
  if (link?.docs?.length && !link.docs.includes(key)) throw AppError.of("NOT_FOUND", 404, "קובץ");
  return { doc, row: (doc.documents || []).find((d) => d.key === key) };
}

/* ── the bucket (2026-10-26): upload-url → the browser's PUT → confirm; a signed read ── */

const tokenActor = async (req) => {
  const { intake: doc, person, link } = await intake.resolveToken({ token: req.params.token });
  return { token: { kind: "intake", intake: doc, person, link } };
};

/** POST /api/public/join/:token/files/upload-url - { key, name, mime, size, thumb } */
exports.fileUploadUrl = catchAsync(async (req, res) => {
  const actor = await tokenActor(req);
  const b = req.body || {};
  if (!b.key || !b.mime) throw AppError.of("MISSING_FIELDS", 400, "key, mime");
  const out = await files.beginUpload({ actor, family: "intake", owner: { id: actor.token.intake._id, slot: b.key }, name: b.name, mime: b.mime, size: b.size, thumb: b.thumb === true });
  res.status(201).json({ status: "success", data: out });
});

/** POST /api/public/join/:token/files/:id/confirm → { view } */
exports.fileConfirm = catchAsync(async (req, res) => {
  const out = await files.confirmUpload({ actor: await tokenActor(req), fileId: req.params.id, meta: {} });
  res.status(200).json({ status: "success", data: out });
});

/** GET /api/public/join/:token/files/:id/url?thumb=1 */
exports.fileUrl = catchAsync(async (req, res) => {
  const out = await files.signedRead({ actor: await tokenActor(req), fileId: req.params.id, thumb: req.query.thumb === "1", download: req.query.download === "1" });
  res.set("Cache-Control", "private, no-store");
  res.status(200).json({ status: "success", data: out });
});

/** GET /api/public/join/:token/documents/:key/file - the person looks at what they (or the office) uploaded: a 302 to a signed read. */
exports.fileByToken = catchAsync(async (req, res) => {
  const { row } = await rowForLink(req);
  if (!(await storedFiles.redirectIfRemote(req, res, row?.file?.stored))) throw AppError.of("NOT_FOUND", 404, "קובץ");
});

/** GET /api/public/join/:token/documents/:key/thumb - a 302 to the thumbnail in the bucket. */
exports.thumbByToken = catchAsync(async (req, res) => {
  const { row } = await rowForLink(req);
  if (!(await storedFiles.redirectIfRemote(req, res, row?.file?.stored, { thumb: true }))) throw AppError.of("NOT_FOUND", 404, "תמונה מוקטנת");
});

/** DELETE /api/public/join/:token/documents/:key - pull back an unconfirmed upload. */
exports.removeByToken = catchAsync(async (req, res) => {
  const { intake: doc, person, link } = await intake.resolveToken({ token: req.params.token });
  const out = await intake.removeStudentDocument({ intake: doc, key: req.params.key });
  const saved = out.intake || out;
  res.status(200).json({ status: "success", data: { view: intake.publicView(saved, person, link) } });
});
