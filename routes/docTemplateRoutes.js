/**
 * @file Doc template routes - the staff's written templates.
 * Mounted at /api/doc-templates: every staff kind reads what it may see and writes its own
 * (a teacher's account never reaches /api outside its own app - teacherGate).
 * @module routes/docTemplateRoutes
 * @see controllers/docTemplateController
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/docTemplateController");

router.route("/").get(c.list).post(c.create);
router.route("/:id").patch(c.update).delete(c.remove);
// who sees it - the maker's and the super admin's to say
router.put("/:id/audience", c.setAudience);

module.exports = router;
