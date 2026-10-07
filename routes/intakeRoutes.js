/**
 * @file Intake routes - the social worker's board
 * @module routes/intakeRoutes
 * @see controllers/intakesController
 */

const express = require("express");
const router = express.Router();
const {
  getIntakes,
  getIntake,
  getByPerson,
  openIntake,
  scheduleForPerson,
  screenPerson,
  reschedule,
  markDone,
  setDocument,
  uploadDocument,
  getDocumentFile,
  setShkedia,
  setCoordinator,
  setScreening,
  setCommittee,
  createLink,
  getLinks,
  updateIntake,
} = require("../controllers/intakesController");

// staff uploads carry base64 files too
// (staff uploads are base64 in JSON - the body limit is the global one in app.js)

// Static paths before /:id
router.post("/open", openIntake);
router.post("/schedule", scheduleForPerson);
router.post("/screening", screenPerson);
router.get("/person/:personId", getByPerson);

router.get("/", getIntakes);
router.route("/:id").get(getIntake).patch(updateIntake);
router.post("/:id/schedule", reschedule);
router.post("/:id/done", markDone);
router.post("/:id/documents", uploadDocument);
router.patch("/:id/documents/:key", setDocument);
router.get("/:id/documents/:key/file", getDocumentFile);
// 2026-10-07 - the social worker's round
router.patch("/:id/shkedia", setShkedia);
router.patch("/:id/coordinator", setCoordinator);
router.patch("/:id/screening", setScreening);
router.patch("/:id/committee", setCommittee);
router.route("/:id/links").get(getLinks).post(createLink);

module.exports = router;
