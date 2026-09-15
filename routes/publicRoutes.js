/**
 * @file Public routes — the sign-up page (no login)
 * @module routes/publicRoutes
 * @see controllers/publicController
 *
 * Mounted at /api/public with its own, larger JSON limit: document
 * uploads travel as base64 in the body (one file per request, ≤ 8MB).
 */

const express = require("express");
const router = express.Router();
const { joinOptions, join, viewByToken, uploadByToken, removeByToken } = require("../controllers/publicController");

router.use(express.json({ limit: "12mb" }));

router.get("/join/options", joinOptions);
router.post("/join", join);
router.get("/join/:token", viewByToken);
router.post("/join/:token/documents", uploadByToken);
router.delete("/join/:token/documents/:key", removeByToken);

module.exports = router;
