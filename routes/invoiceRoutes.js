/**
 * @file Invoice routes - /api/invoices (חשבוניות של מורים)
 * @module routes/invoiceRoutes
 * @see controllers/invoiceController
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/invoiceController");

// the picture arrives as a base64 data URL in JSON (the global 16mb body limit)

router.get("/lessons", c.getTeacherLessons); // before /:id
router.route("/").get(c.getInvoices).post(c.createInvoice);
router.route("/:id").get(c.getInvoice).patch(c.updateInvoice).delete(c.deleteInvoice);
router.get("/:id/image", c.getImage);

module.exports = router;
