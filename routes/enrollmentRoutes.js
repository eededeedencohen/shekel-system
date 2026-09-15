/**
 * @file Enrollment routes
 * @module routes/enrollmentRoutes
 * @see controllers/enrollmentController
 */

const express = require("express");
const router = express.Router();
const {
  getEnrollments,
  createEnrollment,
  patchEnrollment,
  deleteEnrollment,
} = require("../controllers/enrollmentController");

router.route("/").get(getEnrollments).post(createEnrollment);
router.route("/:id").patch(patchEnrollment).delete(deleteEnrollment);

module.exports = router;