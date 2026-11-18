/**
 * @file Invoice round routes - the coordinator's side of the monthly round
 * (שמרית's round, 2026-10-14). Mounted at /api/invoice-rounds under the
 * `invoices` family; the teacher's side is under /api/public/invoices.
 * @module routes/invoiceRoundRoutes
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/invoiceRoundController");
const { hasFeature } = require("../utils/auth");
const AppError = require("../utils/AppError");

/** The corrections belong to the super admin and to whoever was given the "invoices" grant - as the ACTING one. */
const requireInvoiceAdmin = (req, res, next) => (hasFeature(req.actor, "invoices") ? next() : next(AppError.of("AUTH_FORBIDDEN", 403)));

router.route("/").get(c.list).post(c.open);
router.route("/:id").get(c.getOne).delete(c.remove);
router.post("/:id/mail", c.setMail);
router.post("/:id/note", c.setNote);
router.get("/:id/requests/:rid/link", c.requestLink);
router.post("/:id/requests/:rid/sent", c.markSent);
router.post("/:id/requests/:rid/renew", c.renew);
router.post("/:id/requests/:rid/reopen", c.reopen);
router.post("/:id/requests/:rid/mode", c.setMode);
// the month as her ledger sheet (2026-11-10)
router.get("/:id/ledger.xlsx", c.ledgerXlsx);
// the corrections (the state machine of 2026-10-22, section 08): resets and deletions - the super admin, and the
// holder of the "invoices" grant
router.post("/:id/admin", requireInvoiceAdmin, c.admin);

module.exports = router;
