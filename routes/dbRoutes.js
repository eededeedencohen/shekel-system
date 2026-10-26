/**
 * @file Database explorer routes (read-only)
 * @module routes/dbRoutes
 * @see controllers/dbController
 */

const express = require("express");
const router = express.Router();
const {
  getDbSchema,
  getDbCollection,
  getDbRecord,
  getStorage,
  getCosts,
} = require("../controllers/dbController");

router.get("/schema", getDbSchema);
// how full the database and the files bucket are, and what Amazon charges (2026-10-26) - before /:collection
router.get("/storage", getStorage);
router.get("/costs", getCosts);
router.get("/:collection", getDbCollection);
router.get("/:collection/:id", getDbRecord);

module.exports = router;
