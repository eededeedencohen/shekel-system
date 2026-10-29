/**
 * @file Gym routes - חדר כושר פרופיט
 * @module routes/gymRoutes
 * @see controllers/gymController
 *
 * Mounted at /api/gym behind requireFeature("gym") (app.js). A member row
 * is reached only when its person is in the lens (lensService guard).
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/gymController");
const lens = require("../services/lensService");
const GymMembership = require("../models/GymMembership");

router.param("id", lens.guardByPerson(GymMembership));

router.route("/").get(c.list).post(c.add);
router.route("/:id").get(c.get).patch(c.update).delete(c.remove);
router.post("/:id/membership", c.setMembership);
router.post("/:id/sent", c.markSent);
router.route("/:id/link").get(c.getLink).post(c.renewLink);
router.get("/:id/signature", c.signature);

module.exports = router;
