/**
 * @file Incident routes — דיווח אירוע חריג
 * @module routes/incidentRoutes
 * @see controllers/incidentController
 */

const express = require("express");
const router = express.Router();
const { getIncidents, createIncident, updateIncident } = require("../controllers/incidentController");

router.route("/").get(getIncidents).post(createIncident);
router.patch("/:id", updateIncident);

module.exports = router;
