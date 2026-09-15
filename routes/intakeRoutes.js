/**
 * @file Intake routes — the social worker's board
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
  reschedule,
  markDone,
  setDocument,
  uploadDocument,
  getDocumentFile,
  updateIntake,
} = require("../controllers/intakesController");

// staff uploads carry base64 files too
router.use(express.json({ limit: "12mb" }));

// Static paths before /:id
router.post("/open", openIntake);
router.post("/schedule", scheduleForPerson);
router.get("/person/:personId", getByPerson);

router.get("/", getIntakes);
router.route("/:id").get(getIntake).patch(updateIntake);
router.post("/:id/schedule", reschedule);
router.post("/:id/done", markDone);
router.post("/:id/documents", uploadDocument);
router.patch("/:id/documents/:key", setDocument);
router.get("/:id/documents/:key/file", getDocumentFile);

module.exports = router;
