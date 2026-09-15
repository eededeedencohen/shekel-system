/**
 * @file Event-registration routes — /api/event-registrations
 * @module routes/registrationRoutes
 * @see controllers/eventController
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/eventController");

router.route("/").get(c.getRegistrations).post(c.register);
router.post("/:id/cancel", c.cancelRegistration);
router.patch("/:id/attendance", c.reportAttendance);

module.exports = router;
