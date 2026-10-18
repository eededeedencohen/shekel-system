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
const Enrollment = require("../models/Enrollment");
const lens = require("../services/lensService");

// a seat is reachable only when its cycle is on the acting persona's side (services/lensService)
router.param("id", lens.guardByCycle(Enrollment));

router.route("/").get(getEnrollments).post(createEnrollment);
router.route("/:id").patch(patchEnrollment).delete(deleteEnrollment);

module.exports = router;