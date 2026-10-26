/**
 * @file Enrollment controller - membership records (roster / seats / holds)
 * @module controllers/enrollmentController
 *
 * All writes delegate to services/enrollmentService - capacity, slot
 * validation and pipeline auto-advance live there and only there. The unique {cycle,student} index backstops everything.
 */

const Enrollment = require("../models/Enrollment");
const { enroll, updateStatus, enrollResidents } = require("../services/enrollmentService");
const { byOf } = require("../utils/actor");
const { attachStudentData } = require("../services/profileService");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const lens = require("../services/lensService");

// pipeline/matching/residence live on the student PROFILE now - populate
// identity, then merge the profile fields in (attachStudentData).
const STUDENT_POP = { path: "student", select: "firstName lastName avatar birthDate deletedAt" };

/** GET /api/enrollments?cycle=&student=&status= */
exports.getEnrollments = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.cycle) filter.cycle = req.query.cycle;
  if (req.query.student) filter.student = req.query.student;
  if (req.query.status) filter.status = { $in: req.query.status.split(",") };
  await lens.narrowByCycle(req, filter); // the seats of the lens's cycles only
  const docs = await Enrollment.find(filter).populate(STUDENT_POP).sort({ createdAt: 1 });
  const enrollments = await attachStudentData(docs.map((e) => e.toObject()));
  res.status(200).json({ status: "success", results: enrollments.length, data: { enrollments } });
});

/**
 * POST /api/enrollments - enroll or reserve.
 * Body: { cycle*, student*, status? ("active"|"reserved", default active),
 *         slotId?, note?, createdBy?, joinedAt? }
 */
exports.createEnrollment = catchAsync(async (req, res) => {
  // the cycle and the student must both be the acting persona's (lensService)
  await lens.assertCycle(req, req.body.cycle);
  await lens.assertPerson(req, req.body.student);
  const enrollment = await enroll({
    cycleId: req.body.cycle,
    studentId: req.body.student,
    status: req.body.status || "active",
    slotId: req.body.slotId || null,
    note: req.body.note,
    createdBy: byOf(req),
    joinedAt: req.body.joinedAt,
  });
  await enrollment.populate(STUDENT_POP);
  const [withProfile] = await attachStudentData([enrollment.toObject()]);
  res.status(201).json({ status: "success", data: { enrollment: withProfile } });
});

/**
 * POST /api/enrollments/residents - "הוסף את כל דיירי ההוסטל": every
 * resident of the cycle's hostel takes an active seat (enrollmentService
 * enrollResidents). Body: { cycle, createdBy }.
 */
exports.enrollResidents = catchAsync(async (req, res) => {
  await lens.assertCycle(req, req.body.cycle);
  const result = await enrollResidents({ cycleId: req.body.cycle, createdBy: byOf(req) });
  const docs = [];
  for (const e of result.created) {
    await e.populate(STUDENT_POP);
    docs.push(e.toObject());
  }
  const enrollments = await attachStudentData(docs);
  res.status(201).json({ status: "success", data: { enrollments, skipped: result.skipped, tagged: result.tagged, residents: result.residents } });
});

/**
 * PATCH /api/enrollments/:id - status transition / note / leftAt.
 * Body: { status?, leftAt?, joinedAt?, note?, movedBy? }
 * `status: "active"` + `joinedAt` = the managers' "קביעת תאריך התחלה" on a
 * held seat - the student moves to Placed (enrollmentService).
 */
exports.patchEnrollment = catchAsync(async (req, res) => {
  const enrollment = await updateStatus({
    enrollmentId: req.params.id,
    status: req.body.status,
    leftAt: req.body.leftAt,
    joinedAt: req.body.joinedAt,
    note: req.body.note,
    movedBy: byOf(req),
  });
  await enrollment.populate(STUDENT_POP);
  const [withProfile] = await attachStudentData([enrollment.toObject()]);
  res.status(200).json({ status: "success", data: { enrollment: withProfile } });
});

/** DELETE /api/enrollments/:id - remove a wrong record outright. */
exports.deleteEnrollment = catchAsync(async (req, res, next) => {
  const enrollment = await Enrollment.findOneAndDelete({ _id: req.params.id });
  if (!enrollment) return next(AppError.of("NOT_FOUND", 404, "שיבוץ"));
  res.status(204).json({ status: "success", data: null });
});
