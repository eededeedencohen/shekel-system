/**
 * @file File routes - the files bucket (2026-10-26)
 * @module routes/fileRoutes
 * @see controllers/fileController
 *
 * No family gate on the router: a file's own `family` and `owner` decide
 * inside (services/fileAccess, fileService.FAMILY_RULES).
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/fileController");

router.post("/upload-url", c.uploadUrl);
router.post("/urls", c.urls);
router.post("/:id/confirm", c.confirm);
router.get("/:id/url", c.url);
router.delete("/:id", c.remove);

module.exports = router;
