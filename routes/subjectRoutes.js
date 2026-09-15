/**
 * @file Subject routes
 * @module routes/subjectRoutes
 * @see controllers/subjectController
 */

const express = require("express");
const router = express.Router();
const {
  getSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
} = require("../controllers/subjectController");

router.route("/").get(getSubjects).post(createSubject);
router.route("/:id").put(updateSubject).delete(deleteSubject);

module.exports = router;
