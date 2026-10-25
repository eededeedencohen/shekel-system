/**
 * @file Meta routes - domain enums
 * @module routes/metaRoutes
 * @see controllers/metaController
 */

const express = require("express");
const router = express.Router();
const { getDomain } = require("../controllers/metaController");

router.get("/domain", getDomain);

module.exports = router;
