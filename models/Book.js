/**
 * @file Book model — one physical book of the library (הספרייה)
 * @module models/Book
 *
 * A book is identified by the barcode printed on it (the EAN / the
 * bookshop's own code — booknet uses 11 digits, ISBNs 13). The library
 * holds ONE copy per title (Eden, 2026-09-09), so "is it available" is a
 * question for the `loans` collection: an open Loan ⇒ with a student.
 *
 * The details come from the scan flow (services/bookLookupService pulls
 * title / author / summary / cover from booknet, then Google Books) or
 * were typed by hand — `source` says which. The cover image lives on disk
 * under UPLOAD_DIR/<world>/books/ (like intake documents); the record
 * keeps the metadata only. Books are soft-deleted so old loans keep their
 * title.
 */

const mongoose = require("mongoose");
const { WORLDS, BOOK_SOURCES } = require("../utils/domain");

const bookSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    /** Digits (and X for old ISBN-10s), as printed under the bars. */
    barcode: { type: String, required: [true, "חובה להזין ברקוד"], trim: true },
    title: { type: String, required: [true, "חובה להזין שם ספר"], trim: true },
    author: { type: String, trim: true, default: "" },
    summary: { type: String, trim: true, default: "" },
    publisher: { type: String, trim: true },
    year: { type: Number, min: 1000, max: 2200 },
    pages: { type: Number, min: 1 },
    /** Where the details came from. */
    source: { type: String, enum: BOOK_SOURCES, default: "manual" },
    /** The shop page the details were read from (booknet). */
    productUrl: { type: String, trim: true },
    /** The remote cover image (kept for re-download / reference). */
    imageUrl: { type: String, trim: true },
    /** The stored cover, when one was saved to disk. */
    cover: {
      storedName: { type: String, trim: true },
      mime: { type: String, trim: true },
      size: { type: Number, min: 0 },
      savedAt: { type: Date },
    },
    /** Free text for the staff — "עותק ישן", "תרומה של…". */
    notes: { type: String, trim: true, default: "" },
    /** Persona name (no auth yet). */
    addedBy: { type: String, trim: true },
    /** Soft delete — old loans still point here. */
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "books" }
);

bookSchema.index({ world: 1, barcode: 1 }, { unique: true });
bookSchema.index({ world: 1, deletedAt: 1, title: 1 });

module.exports = mongoose.model("Book", bookSchema);
