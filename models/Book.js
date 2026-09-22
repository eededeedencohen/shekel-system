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
 * were typed by hand — `source` says which. The cover image lives IN the
 * record (`cover.data`, 2026-09-22): the server's disk is wiped on every
 * deploy, so a file on it was gone within days (Eden: "שהתמונות יישמרו").
 * Covers are small (the page shrinks a photo to ~700px before sending;
 * booknet's are ~40KB), and a cover up to INLINE_COVER_BYTES travels with
 * the book itself as `coverData` (a data URL) in every JSON — the client
 * keeps it in its boot state and shows it at once, no second request.
 * Bigger ones are fetched from GET /books/:id/cover. Books are
 * soft-deleted so old loans keep their title.
 */

const mongoose = require("mongoose");
const { WORLDS, BOOK_SOURCES } = require("../utils/domain");

/** A cover this small is inlined into the book's JSON. */
const INLINE_COVER_BYTES = 96 * 1024;

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
    /** The stored cover — the image bytes themselves (see the header). */
    cover: {
      data: { type: Buffer },
      /** Legacy (until scripts/migrateCoversToDb.js ran): the file's name under UPLOAD_DIR/<world>/books/. */
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

/**
 * JSON never carries the raw bytes: a small cover becomes `coverData`
 * (a data URL, ready for <img src>), a big one is left to the cover route.
 */
function stripCover(doc, ret) {
  const c = ret.cover;
  if (c && c.data) {
    const buf = Buffer.isBuffer(c.data) ? c.data : Buffer.from(c.data);
    if (buf.length && buf.length <= INLINE_COVER_BYTES && c.mime) ret.coverData = `data:${c.mime};base64,${buf.toString("base64")}`;
    delete c.data;
  }
  return ret;
}
bookSchema.set("toJSON", { transform: stripCover });
bookSchema.set("toObject", { transform: stripCover });

const Book = mongoose.model("Book", bookSchema);
Book.INLINE_COVER_BYTES = INLINE_COVER_BYTES;
module.exports = Book;
