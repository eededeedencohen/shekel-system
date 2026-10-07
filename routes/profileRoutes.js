/**
 * @file Profile routes — operations addressed by PROFILE id
 * @module routes/profileRoutes
 * @see controllers/profileController
 *
 * (The nested person-addressed paths — /api/people/:id/profiles — live in
 * personRoutes and point at the same controller.)
 */

const express = require("express");
const router = express.Router();
const {
  getProfiles,
  getProfileById,
  updateProfile,
  deactivateProfile,
  moveStage,
  updateMatching,
} = require("../controllers/profileController");
const { closeProfile, leaveProgram, reopenProfile } = require("../controllers/programController");

router.get("/", getProfiles);
router.route("/:id").get(getProfileById).patch(updateProfile).delete(deactivateProfile);
router.post("/:id/stage", moveStage);
router.patch("/:id/matching", updateMatching);
// Lifecycle with a reason (logged) — DELETE above stays as the bare form.
router.post("/:id/close", closeProfile);
// דיווח עזיבה (2026-10-07): the official leave date, a reason, "שקדיה was told" — plus the activity
router.post("/:id/leave", leaveProgram);
router.post("/:id/reopen", reopenProfile);

module.exports = router;
