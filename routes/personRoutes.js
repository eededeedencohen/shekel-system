/**
 * @file Person routes — identity + the person-addressed profile paths
 * @module routes/personRoutes
 * @see controllers/personController, controllers/profileController,
 *      controllers/intakeController
 *
 * /:id/stage and /:id/matching are COMPAT paths (person-addressed) kept for
 * the deprecation window — the canonical ones live under /api/profiles/:id.
 */

const express = require("express");
const router = express.Router();
const {
  getPeople,
  getPersonById,
  createPerson,
  updatePerson,
  deletePerson,
  updateAvailability,
  getPersonEnrollments,
} = require("../controllers/personController");
const {
  getPersonProfiles,
  createPersonProfile,
  personMoveStage,
  personUpdateMatching,
} = require("../controllers/profileController");
const { createIntakeLead } = require("../controllers/intakeController");
const { transferProgram, getProgramTimeline } = require("../controllers/programController");

// Static paths before /:id
router.post("/intake", createIntakeLead);

router.route("/").get(getPeople).post(createPerson);
router.route("/:id").get(getPersonById).put(updatePerson).delete(deletePerson);
router.route("/:id/profiles").get(getPersonProfiles).post(createPersonProfile);
router.patch("/:id/availability", updateAvailability);
router.get("/:id/enrollments", getPersonEnrollments);
// Programs (מכללה לכל ↔ תרבות לכל): the transfer + the merged story
router.post("/:id/transfer", transferProgram);
router.get("/:id/programs", getProgramTimeline);

// COMPAT — person-addressed pipeline/matching (canonical: /api/profiles/:id)
router.post("/:id/stage", personMoveStage);
router.patch("/:id/matching", personUpdateMatching);

module.exports = router;
