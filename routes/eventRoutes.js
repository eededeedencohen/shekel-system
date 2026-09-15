/**
 * @file Event routes — /api/events (תרבות לכל)
 * @module routes/eventRoutes
 * @see controllers/eventController
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/eventController");

router.route("/").get(c.getEvents).post(c.createEvent);
router.route("/:id").get(c.getEventById).put(c.updateEvent).delete(c.deleteEvent);
router.post("/:id/publish", c.publishEvent);
router.post("/:id/cancel", c.cancelEvent);
router.post("/:id/done", c.markEventDone);

module.exports = router;
