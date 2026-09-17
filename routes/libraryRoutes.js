/**
 * @file Library routes — /api/library (הספרייה)
 * @module routes/libraryRoutes
 * @see controllers/libraryController
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/libraryController");

// covers arrive as base64 data URLs (≤ 3MB decoded)
// (cover data URLs ride in JSON — the body limit is the global one in app.js)

router.get("/lookup/:barcode", c.lookupBarcode);

router.route("/books").get(c.getBooks).post(c.createBook);
router.route("/books/:id").get(c.getBook).patch(c.updateBook).delete(c.deleteBook);
router.get("/books/:id/cover", c.getCover);
router.post("/books/:id/lend", c.lend);

router.get("/loans", c.getLoans);
router.post("/loans/:id/extend", c.extend);
router.post("/loans/:id/return", c.returnBook);

module.exports = router;
