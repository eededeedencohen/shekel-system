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
} = require("../controllers/dbController");

router.get("/schema", getDbSchema);
router.get("/:collection", getDbCollection);
router.get("/:collection/:id", getDbRecord);

module.exports = router;
