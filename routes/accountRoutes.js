/**
 * @file Staff accounts routes - the users page
 * @module routes/accountRoutes
 * @see controllers/authController
 *
 * Mounted at /api/accounts, super admin only.
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/authController");
const { requireSuper } = require("../utils/auth");

router.use(requireSuper);
router.get("/", c.listAccounts);
router.post("/", c.createAccount);
router.patch("/:id", c.updateAccount);
router.post("/:id/reset", c.createResetLink);

module.exports = router;
