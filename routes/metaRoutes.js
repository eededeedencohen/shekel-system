/**
 * @file Meta routes — domain enums + world counts
 * @module routes/metaRoutes
 * @see controllers/metaController
 */

const express = require("express");
const router = express.Router();
const { getDomain, getWorlds } = require("../controllers/metaController");

router.get("/domain", getDomain);
router.get("/worlds", getWorlds);

module.exports = router;
