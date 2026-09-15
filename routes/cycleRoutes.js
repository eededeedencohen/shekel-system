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

router.route("/").get(getCycles).post(createCycle);
router.route("/:id").get(getCycleById).put(updateCycle).delete(deleteCycle);

module.exports = router;
