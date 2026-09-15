/**
 * @file Cycle controller — lean, world-scoped cycle CRUD
 * @module controllers/cycleController
 *
 * The cohort is NOT here (see enrollmentController) — list responses are
 * lean and constant-size. Body writes are whitelisted; enrollment data can
 * no longer ride in on a cycle update (it lives in another collection with
 * a unique index).
 */

const Cycle = require("../models/Cycle");
const Subject = require("../models/Subject");
const Enrollment = require("../models/Enrollment");
const Lesson = require("../models/Lesson");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

const POPULATE = [
  { path: "subject", select: "name category active" },
  { path: "teacher", select: "firstName lastName avatar" },
  { path: "hostel", select: "name" },
  { path: "venue.hostel", select: "name" },
  { path: "schedule.room", select: "name" },
  { path: "matching.requiredRooms", select: "name" },
];

const WRITE_FIELDS = [
  "subject", "teacher", "status", "startDate", "endDate",
  "schedule", "hostel", "venue", "matching",
];
const pickBody = (body) => {
  const out = {};
  for (const k of WRITE_FIELDS) if (k in body) out[k] = body[k];
  return out;
};

/** GET /api/cycles?status=&subject=&teacher=&hostel=&track=hostel|college */
exports.getCycles = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  if (req.query.status) filter.status = { $in: req.query.status.split(",") };
  if (req.query.subject) filter.subject = req.query.subject;
  if (req.query.teacher) filter.teacher = req.query.teacher;
  if (req.query.hostel) filter.hostel = req.query.hostel;
  else if (req.query.track === "hostel") filter.hostel = { $ne: null };
  else if (req.query.track === "college") filter.hostel = null;

  const cycles = await Cycle.find(filter).populate(POPULATE);
  res.status(200).json({ status: "success", results: cycles.length, data: { cycles } });
});

/** GET /api/cycles/:id */
exports.getCycleById = catchAsync(async (req, res, next) => {
  const cycle = await Cycle.findOne({ _id: req.params.id, world: req.world }).populate(POPULATE);
  if (!cycle) return next(AppError.of("NOT_FOUND", 404, "מחזור"));
  res.status(200).json({ status: "success", data: { cycle } });
});

/** POST /api/cycles */
exports.createCycle = catchAsync(async (req, res, next) => {
  // Worlds never mix: the subject must belong to the request's world.
  if (req.body.subject) {
    const subject = await Subject.findById(req.body.subject).select("world");
    if (!subject) return next(AppError.of("NOT_FOUND", 404, "מקצוע"));
    if (subject.world !== req.world) return next(AppError.of("WORLD_MISMATCH", 400));
  }
  const cycle = await Cycle.create({ ...pickBody(req.body), world: req.world });
  await cycle.populate(POPULATE);
  res.status(201).json({ status: "success", data: { cycle } });
});

/** PUT /api/cycles/:id — whitelisted merge through document validation. */
exports.updateCycle = catchAsync(async (req, res, next) => {
  const cycle = await Cycle.findOne({ _id: req.params.id, world: req.world });
  if (!cycle) return next(AppError.of("NOT_FOUND", 404, "מחזור"));
  Object.assign(cycle, pickBody(req.body));
  await cycle.save();
  await cycle.populate(POPULATE);
  res.status(200).json({ status: "success", data: { cycle } });
});

/**
 * DELETE /api/cycles/:id — refused while enrollments/lessons reference it
 * (end a cycle with status Cancelled/Completed instead).
 */
exports.deleteCycle = catchAsync(async (req, res, next) => {
  const cycle = await Cycle.findOne({ _id: req.params.id, world: req.world });
  if (!cycle) return next(AppError.of("NOT_FOUND", 404, "מחזור"));
  const [enr, les] = await Promise.all([
    Enrollment.countDocuments({ cycle: cycle._id }),
    Lesson.countDocuments({ cycle: cycle._id }),
  ]);
  if (enr || les) {
    return next(AppError.of("REFERENCED_BLOCKED", 409, `${enr} שיבוצים, ${les} שיעורים`));
  }
  await Cycle.deleteOne({ _id: cycle._id });
  res.status(204).json({ status: "success", data: null });
});
