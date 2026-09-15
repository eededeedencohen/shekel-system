/**
 * @file Lesson routes
 * @module routes/lessonRoutes
 * @see controllers/lessonController
 *
 * Note: /attendance (the grid upsert) is registered before /:id.
 */

const express = require("express");
const router = express.Router();
const {
  getLessons,
  getLessonById,
  upsertAttendance,
  patchAttendanceRecord,
  deleteAttendanceRecord,
  deleteLesson,
} = require("../controllers/lessonController");

router.put("/attendance", upsertAttendance);
router.route("/").get(getLessons);
router.route("/:id").get(getLessonById).delete(deleteLesson);
router
  .route("/:id/attendance/:studentId")
  .patch(patchAttendanceRecord)
  .delete(deleteAttendanceRecord);

module.exports = router;
