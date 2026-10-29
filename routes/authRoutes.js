/**
 * @file Auth routes - signing in and one's own password
 * @module routes/authRoutes
 * @see controllers/authController
 *
 * Mounted at /api/auth. login / logout / forgot / reset/:token are open
 * (utils/auth OPEN); the rest need a session.
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/authController");

router.post("/login", c.login);
router.post("/logout", c.logout);
router.post("/forgot", c.forgot);
router.get("/reset/:token", c.resetInfo);
router.post("/reset/:token", c.resetPassword);
router.get("/me", c.me);
router.post("/password", c.changePassword);
router.get("/staff", c.staff);
// the presence heartbeat (2026-10-29): the browser says "still here" once a minute while its tab is visible
router.post("/ping", c.ping);
// the goodbye: the tab closed (navigator.sendBeacon on pagehide) - the person leaves the "online" list at once
router.post("/bye", c.bye);

module.exports = router;
