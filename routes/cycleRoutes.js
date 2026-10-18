/**
 * @file Cycle routes
 * @module routes/cycleRoutes
 * @see controllers/cycleController
 */

const express = require("express");
const router = express.Router();
const {
  getCycles,
  getCycleById,
  createCycle,
  updateCycle,
  deleteCycle,
} = require("../controllers/cycleController");
const lens = require("../services/lensService");

// a cycle is reachable only on the acting persona's side (hostel / college - services/lensService)
router.param("id", lens.guardCycle);

router.route("/").get(getCycles).post(createCycle);
router.route("/:id").get(getCycleById).put(updateCycle).delete(deleteCycle);

module.exports = router;
