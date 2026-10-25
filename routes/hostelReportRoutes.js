/**
 * @file Hostel report routes - the coordinator's side of the houses'
 * attendance drafts (phase 3 of שמרית's round). Mounted at
 * /api/hostel-reports under the `hostels` family; the house's side is
 * under /api/public/hostel-reports/:token.
 * @module routes/hostelReportRoutes
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/hostelReportController");

router.route("/").get(c.list).post(c.open);
// the Ministry of Health's month - before /:id
router.get("/ministry", c.ministry);
router.get("/ministry.xlsx", c.ministryXlsx);
router.route("/:id").get(c.getOne).delete(c.remove);
router.post("/:id/sent", c.markSent);
router.post("/:id/renew", c.renew);
router.post("/:id/reopen", c.reopen);
router.post("/:id/note", c.setNote);
router.post("/:id/approve", c.approveAll);
router.post("/:id/sessions/:sid/approve", c.approveSession);
// her own word on a session (Eden, 2026-10-25): held or not, and one person's mark
router.post("/:id/sessions/:sid/state", c.setState);
router.post("/:id/sessions/:sid/marks", c.setMark);
router.post("/:id/extras/:xid/resolve", c.resolveExtra);
router.post("/:id/left/:lid/resolve", c.resolveLeft);

module.exports = router;
