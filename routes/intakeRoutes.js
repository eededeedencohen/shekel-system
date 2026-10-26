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
  getDocumentThumb,
  signWaiver,
  getWaiver,
  setShkedia,
  setCoordinator,
  setScreening,
  setCommittee,
  createLink,
  getLinks,
  getLink,
  updateIntake,
} = require("../controllers/intakesController");
const Intake = require("../models/Intake");
const lens = require("../services/lensService");

// staff uploads carry base64 files too
// (staff uploads are base64 in JSON - the body limit is the global one in app.js)

// a file is reachable only when its person is in the acting persona's lens (services/lensService)
router.param("id", lens.guardByPerson(Intake));
router.param("personId", lens.guardPerson);

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
router.get("/:id/documents/:key/thumb", getDocumentThumb);
// 2026-10-11 - ויתור סודיות signed on the screen during the intake
router.route("/:id/waiver").get(getWaiver).post(signWaiver);
// 2026-10-07 - the social worker's round
router.patch("/:id/shkedia", setShkedia);
router.patch("/:id/coordinator", setCoordinator);
router.patch("/:id/screening", setScreening);
router.patch("/:id/committee", setCommittee);
router.route("/:id/links").get(getLinks).post(createLink);
router.get("/:id/link", getLink);

module.exports = router;
