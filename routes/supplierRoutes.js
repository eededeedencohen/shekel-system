/**
 * @file Supplier routes - the coordinator's side of פתיחת תיק ספק
 * @module routes/supplierRoutes
 * @see controllers/supplierController
 *
 * Mounted at /api/suppliers. Every route is the hostels coordinator's (or
 * the super admin's) - requireSupplierStaff reads req.actor.
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/supplierController");
const { requireSuper } = require("../utils/auth");

router.use(c.requireSupplierStaff);
// the super admin's corrections (Eden, 2026-10-15): statuses edited, things deleted
router.post("/:id/admin", requireSuper, c.admin);
router.route("/").get(c.list).post(c.create);
router.route("/:id").get(c.getOne).patch(c.update).delete(c.remove);
router.route("/:id/link").get(c.getLink).post(c.renewLink);
router.post("/:id/review", c.review);
router.post("/:id/seen", c.markSeen);
router.post("/:id/email", c.emailStep);
router.get("/:id/files/:key/file", c.staffFile);
router.get("/:id/files/:key/thumb", c.staffThumb);

module.exports = router;
