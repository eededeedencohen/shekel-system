/**
 * @file Public routes - the sign-up page (no login)
 * @module routes/publicRoutes
 * @see controllers/publicController
 *
 * Mounted at /api/public. Document uploads travel as base64 in the body
 * (one file per request, ≤ 8MB) - the body limit that allows it is the
 * global one in app.js.
 */

const express = require("express");
const router = express.Router();
const { joinOptions, join, viewByToken, uploadByToken, removeByToken, fileByToken, thumbByToken } = require("../controllers/publicController");
const supplier = require("../controllers/supplierController");

router.get("/join/options", joinOptions);
router.post("/join", join);
router.get("/join/:token", viewByToken);
router.post("/join/:token/documents", uploadByToken);
router.delete("/join/:token/documents/:key", removeByToken);
// the person looks at their own file (2026-10-11 - the viewer on the documents page)
router.get("/join/:token/documents/:key/file", fileByToken);
router.get("/join/:token/documents/:key/thumb", thumbByToken);

// פתיחת תיק ספק - the supplier behind the coordinator's link (Eden, 2026-10-14)
router.get("/supplier/:token", supplier.publicView);
router.put("/supplier/:token/form", supplier.publicForm);
router.post("/supplier/:token/files/:key", supplier.publicUpload);
router.delete("/supplier/:token/files/:key", supplier.publicRemove);
router.post("/supplier/:token/files/:key/not-applicable", supplier.publicNotApplicable);
router.get("/supplier/:token/files/:key/file", supplier.publicFile);
router.get("/supplier/:token/files/:key/thumb", supplier.publicThumb);

module.exports = router;
