/**
 * @file Invoice round routes - the coordinator's side of the monthly round
 * (שמרית's round, 2026-10-14). Mounted at /api/invoice-rounds under the
 * `invoices` family; the teacher's side is under /api/public/invoices.
 * @module routes/invoiceRoundRoutes
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/invoiceRoundController");
const { requireSuper } = require("../utils/auth");

router.route("/").get(c.list).post(c.open);
router.route("/:id").get(c.getOne).delete(c.remove);
router.post("/:id/mail", c.setMail);
router.post("/:id/note", c.setNote);
router.post("/:id/requests/:rid/sent", c.markSent);
router.post("/:id/requests/:rid/renew", c.renew);
router.post("/:id/requests/:rid/reopen", c.reopen);
// the super admin's corrections (the state machine of 2026-10-22, section 08): resets and deletions, as himself only
router.post("/:id/admin", requireSuper, c.admin);

module.exports = router;
