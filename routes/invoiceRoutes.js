/**
 * @file Invoice routes - /api/invoices (חשבוניות של מורים)
 * @module routes/invoiceRoutes
 * @see controllers/invoiceController
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/invoiceController");
const lens = require("../services/lensService");
const invoices = require("../services/invoiceService");
const AppError = require("../utils/AppError");

// an invoice is reachable only when it is the acting persona's to see: its
// teacher in the lens and at least one of its lessons on the lens's side
// (services/lensService + invoiceService.visibleTo)
router.param("id", async (req, res, next, id) => {
  try {
    const scope = lens.scopeOf(req);
    if (scope.lens.all) return next();
    const invoice = await invoices.getInvoice({ world: req.world, invoiceId: id }); // 404 when there is none
    if (!invoices.visibleTo(invoice, await scope.people(), await scope.cycleSet())) return next(AppError.of("OUT_OF_SCOPE", 403));
    return next();
  } catch (e) {
    return next(e);
  }
});

// the picture arrives as a base64 data URL in JSON (the global 16mb body limit)

router.get("/lessons", c.getTeacherLessons); // before /:id
router.route("/").get(c.getInvoices).post(c.createInvoice);
router.route("/:id").get(c.getInvoice).patch(c.updateInvoice).delete(c.deleteInvoice);
router.get("/:id/image", c.getImage);

module.exports = router;
