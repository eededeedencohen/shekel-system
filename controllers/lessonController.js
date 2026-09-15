/**
 * @file Lesson controller — targeted lesson reads + attendance writes
 * @module controllers/lessonController
 *
 * No more download-everything: every list read REQUIRES a filter (cycle /
 * student / date / from-to range). Live lessons only by default; the
 * archive (?source=archive|all) is read-only — enforced both here for a
 * clean error AND at the schema layer, where every update/delete path is
 * scoped away from archive docs.
 */

const Lesson = require("../models/Lesson");
const Cycle = require("../models/Cycle");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

const POPULATE = [
  { path: "teacher", select: "firstName lastName" },
  { path: "room", select: "name" },
  { path: "attendance.student", select: "firstName lastName senzeyId avatar" },
];

/** "YYYY-MM-DD" → Date at UTC midnight. */
function toUtcMidnight(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * GET /api/lessons — filters (at least ONE required):
 *   ?cycle=<id>            lessons of one cycle
 *   ?student=<personId>    the student's attendance history (indexed,
 *                          paginated: &limit=&skip=, newest first)
 *   ?date=YYYY-MM-DD       one day
 *   ?from=&to=             date range (the weekly board / home panels)
 * Plus: ?source=live (default) | archive | all
 */
exports.getLessons = catchAsync(async (req, res, next) => {
  const { cycle, student, date, from, to } = req.query;
  if (!cycle && !student && !date && !(from && to)) {
    return next(AppError.of("MISSING_FIELDS", 400, "cycle / student / date / from+to"));
  }

  const filter = { world: req.world };
  const source = req.query.source || "live";
  if (source !== "all") filter.source = source;
  if (cycle) filter.cycle = cycle;
  if (student) filter["attendance.student"] = student;
  if (date) {
    const day = toUtcMidnight(date);
    if (!day) return next(AppError.of("INVALID_DATE", 400));
    filter.date = day; // live dates are setter-normalized to UTC midnight
  } else if (from && to) {
    const f = toUtcMidnight(from);
    const t = toUtcMidnight(to);
    if (!f || !t) return next(AppError.of("INVALID_DATE", 400));
    filter.date = { $gte: f, $lte: t };
  }

  let q = Lesson.find(filter).populate(POPULATE);
  q = student ? q.sort({ date: -1 }) : q.sort({ date: 1 });
  if (req.query.limit) q = q.limit(Number(req.query.limit) || 0);
  if (req.query.skip) q = q.skip(Number(req.query.skip) || 0);

  const lessons = await q;
  res.status(200).json({ status: "success", results: lessons.length, data: { lessons } });
});

/** GET /api/lessons/:id */
exports.getLessonById = catchAsync(async (req, res, next) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, world: req.world }).populate(POPULATE);
  if (!lesson) return next(AppError.of("NOT_FOUND", 404, "שיעור"));
  res.status(200).json({ status: "success", data: { lesson } });
});

/**
 * PUT /api/lessons/attendance — upsert the full grid for one (cycle, date).
 * Body: { cycle*, date* "YYYY-MM-DD", records*: [{student, status, note?}],
 *         teacher?, room? }
 */
exports.upsertAttendance = catchAsync(async (req, res, next) => {
  const { cycle, date, records, teacher, room } = req.body;
  if (!cycle || !date || !Array.isArray(records)) {
    return next(AppError.of("MISSING_FIELDS", 400, "cycle, date, records"));
  }
  const day = toUtcMidnight(date);
  if (!day) return next(AppError.of("INVALID_DATE", 400));

  const cyc = await Cycle.findById(cycle).select("world");
  if (!cyc) return next(AppError.of("NOT_FOUND", 404, "מחזור"));
  if (cyc.world !== req.world) return next(AppError.of("WORLD_MISMATCH", 400));

  const update = { $set: { attendance: records }, $setOnInsert: { world: cyc.world } };
  if (teacher !== undefined) update.$set.teacher = teacher;
  if (room !== undefined) update.$set.room = room;

  const lesson = await Lesson.findOneAndUpdate(
    { cycle, date: day, source: "live" },
    update,
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  ).populate(POPULATE);

  res.status(200).json({ status: "success", data: { lesson } });
});

/**
 * PATCH /api/lessons/:id/attendance/:studentId — single-cell edit.
 * Body: { status?, note? } — status required when creating a new record.
 */
exports.patchAttendanceRecord = catchAsync(async (req, res, next) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, world: req.world });
  if (!lesson) return next(AppError.of("NOT_FOUND", 404, "שיעור"));
  if (lesson.source === "archive") return next(AppError.of("ARCHIVE_READONLY", 400));

  const { status, note } = req.body;
  const record = lesson.attendance.find((r) => String(r.student) === req.params.studentId);
  if (record) {
    if (status !== undefined) record.status = status;
    if (note !== undefined) record.note = note;
  } else {
    if (!status) return next(AppError.of("MISSING_FIELDS", 400, "status"));
    lesson.attendance.push({ student: req.params.studentId, status, note });
  }
  await lesson.save();
  await lesson.populate(POPULATE);
  res.status(200).json({ status: "success", data: { lesson } });
});

/** DELETE /api/lessons/:id/attendance/:studentId — un-report one student. */
exports.deleteAttendanceRecord = catchAsync(async (req, res, next) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, world: req.world });
  if (!lesson) return next(AppError.of("NOT_FOUND", 404, "שיעור"));
  if (lesson.source === "archive") return next(AppError.of("ARCHIVE_READONLY", 400));
  lesson.attendance = lesson.attendance.filter((r) => String(r.student) !== req.params.studentId);
  await lesson.save();
  await lesson.populate(POPULATE);
  res.status(200).json({ status: "success", data: { lesson } });
});

/** DELETE /api/lessons/:id — live lessons only (archive is immutable). */
exports.deleteLesson = catchAsync(async (req, res, next) => {
  const existing = await Lesson.findOne({ _id: req.params.id, world: req.world });
  if (!existing) return next(AppError.of("NOT_FOUND", 404, "שיעור"));
  if (existing.source === "archive") return next(AppError.of("ARCHIVE_READONLY", 400));
  await Lesson.deleteOne({ _id: existing._id }); // schema hook re-scopes anyway
  res.status(204).json({ status: "success", data: null });
});
