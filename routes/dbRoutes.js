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
} = require("../controllers/dbController");

router.get("/schema", getDbSchema);
// how full the database and the files bucket are (2026-10-26) - before /:collection
router.get("/storage", getStorage);
router.get("/:collection", getDbCollection);
router.get("/:collection/:id", getDbRecord);

module.exports = router;
