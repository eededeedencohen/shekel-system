/**
 * @file Enrollment controller — membership records (roster / seats / holds)
 * @module controllers/enrollmentController
 *
 * All writes delegate to services/enrollmentService — capacity, world
 * isolation, slot validation and pipeline auto-advance live there and only
 * there. The unique {cycle,student} index backstops everything.
 */

const Enrollment = require("../models/Enrollment");
const { enroll, updateStatus } = require("../services/enrollmentService");
const { attachStudentData } = require("../services/profileService");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

// pipeline/matching/residence live on the student PROFILE now — populate
// identity, then merge the profile fields in (attachStudentData).
const STUDENT_POP = { path: "student", select: "firstName lastName avatar birthDate deletedAt" };

/** GET /api/enrollments?cycle=&student=&status= */
exports.getEnrollments = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  if (req.query.cycle) filter.cycle = req.query.cycle;
  if (req.query.student) filter.student = req.query.student;
  if (req.query.status) filter.status = { $in: req.query.status.split(",") };
  const docs = await Enrollment.find(filter).populate(STUDENT_POP).sort({ createdAt: 1 });
  const enrollments = await attachStudentData(docs.map((e) => e.toObject()));
  res.status(200).json({ status: "success", results: enrollments.length, data: { enrollments } });
});

/**
 * POST /api/enrollments — enroll or reserve.
 * Body: { cycle*, student*, status? ("active"|"reserved", default active),
 *         slotId?, note?, createdBy?, joinedAt? }
 */
exports.createEnrollment = catchAsync(async (req, res) => {
  const enrollment = await enroll({
    cycleId: req.body.cycle,
    studentId: req.body.student,
    world: req.world,
    status: req.body.status || "active",
    slotId: req.body.slotId || null,
    note: req.body.note,
    createdBy: req.body.createdBy,
    joinedAt: req.body.joinedAt,
  });
  await enrollment.populate(STUDENT_POP);
  const [withProfile] = await attachStudentData([enrollment.toObject()]);
  res.status(201).json({ status: "success", data: { enrollment: withProfile } });
});

/**
 * PATCH /api/enrollments/:id — status transition / note / leftAt.
 * Body: { status?, leftAt?, note?, movedBy? }
 */
exports.patchEnrollment = catchAsync(async (req, res) => {
  const enrollment = await updateStatus({
    enrollmentId: req.params.id,
    world: req.world,
    status: req.body.status,
    leftAt: req.body.leftAt,
    note: req.body.note,
    movedBy: req.body.movedBy,
  });
  await enrollment.populate(STUDENT_POP);
  const [withProfile] = await attachStudentData([enrollment.toObject()]);
  res.status(200).json({ status: "success", data: { enrollment: withProfile } });
});

/** DELETE /api/enrollments/:id — remove a wrong record outright. */
exports.deleteEnrollment = catchAsync(async (req, res, next) => {
  const enrollment = await Enrollment.findOneAndDelete({ _id: req.params.id, world: req.world });
  if (!enrollment) return next(AppError.of("NOT_FOUND", 404, "שיבוץ"));
  res.status(204).json({ status: "success", data: null });
});
