/**
 * @file Incident routes - דיווח אירוע חריג
 * @module routes/incidentRoutes
 * @see controllers/incidentController
 */

const express = require("express");
const router = express.Router();
const { getIncidents, createIncident, updateIncident } = require("../controllers/incidentController");
const Incident = require("../models/Incident");
const lens = require("../services/lensService");

// a report is reachable only when its person is in the acting persona's lens (services/lensService)
router.param("id", lens.guardByPerson(Incident));

router.route("/").get(getIncidents).post(createIncident);
router.patch("/:id", updateIncident);

module.exports = router;
