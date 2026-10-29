/**
 * @file Audit routes - the activity pages
 * @module routes/auditRoutes
 * @see controllers/auditController
 *
 * Mounted at /api/audit, super admin only (app.js puts requireSuper in
 * front - as the ACTING persona, so viewing as someone closes it).
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/auditController");

router.get("/overview", c.overview);
router.get("/presence", c.presence);
router.get("/logins", c.logins);
router.get("/events", c.events);
router.get("/users/:id", c.user);
router.post("/clear", c.clear);

module.exports = router;
