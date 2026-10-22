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
const invoiceLink = require("../controllers/invoiceRoundController");
const hostelReport = require("../controllers/hostelReportController");
const { tokenWorld } = require("../utils/tokenWorld");
const UploadLink = require("../models/UploadLink");
const Intake = require("../models/Intake");
const Supplier = require("../models/Supplier");
const InvoiceRequest = require("../models/InvoiceRequest");
const HostelReport = require("../models/HostelReport");

// a link carries no world: the token says where it lives (utils/tokenWorld)
router.use("/join/:token", tokenWorld([[UploadLink, "token"], [Intake, "landing.token"]]));
router.use("/supplier/:token", tokenWorld([[Supplier, "link.token"]]));
router.use("/invoices/:token", tokenWorld([[InvoiceRequest, "token"]]));
router.use("/hostel-reports/:token", tokenWorld([[HostelReport, "token"]]));

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
router.post("/supplier/:token/finish", supplier.publicFinish);
router.get("/supplier/:token/files/:key/file", supplier.publicFile);
router.get("/supplier/:token/files/:key/thumb", supplier.publicThumb);

// the teacher's month behind the invoice link (שמרית's round, 2026-10-19):
// the month's lessons, each invoice attached to the lessons it covers, "סיימתי"
router.get("/invoices/:token", invoiceLink.publicView);
router.post("/invoices/:token/invoices", invoiceLink.publicInvoice);
router.delete("/invoices/:token/invoices/:iid", invoiceLink.publicRemoveInvoice);
router.get("/invoices/:token/invoices/:iid/image", invoiceLink.publicImage);
router.post("/invoices/:token/done", invoiceLink.publicDone);

// the house's month behind the hostel contact's link (phase 3 of שמרית's
// round): who came to each session and why not, someone not on the list,
// someone who left - a draft the coordinator approves
router.get("/hostel-reports/:token", hostelReport.publicView);
router.put("/hostel-reports/:token/sessions/:sid", hostelReport.publicSession);
router.post("/hostel-reports/:token/extras", hostelReport.publicAddExtra);
router.delete("/hostel-reports/:token/extras/:xid", hostelReport.publicRemoveExtra);
router.post("/hostel-reports/:token/left", hostelReport.publicAddLeft);
router.delete("/hostel-reports/:token/left/:lid", hostelReport.publicRemoveLeft);
router.post("/hostel-reports/:token/done", hostelReport.publicDone);

module.exports = router;
