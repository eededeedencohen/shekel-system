/**
 * @file WaitList - a waiting list of מכללה לכל (Eden, 2026-11-24: "תבנה לי
 * עמוד מדהים למכללה לכל של רשימת המתנה"). One list per subject, as the
 * staff's old sheet held a column per subject; the people who wait in it
 * are WaitEntry rows. A list may stand with no subject of the system (a
 * subject nobody teaches yet: that is how one sees when a course is worth
 * opening).
 * @module models/WaitList
 */

const mongoose = require("mongoose");

const waitListSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    /** The subject of the system this list waits for - null when the system has none by that name. */
    subject: { type: mongoose.Schema.Types.ObjectId, ref: "Subject", default: null },
    note: { type: String, trim: true, maxlength: 300, default: "" },
    /** The lists' own order on the page. */
    order: { type: Number, default: 0 },
    /** A list taken off the page; its history stays. */
    archivedAt: { type: Date, default: null },
    createdBy: { type: String, trim: true },
  },
  { timestamps: true, collection: "waitLists" }
);

module.exports = mongoose.model("WaitList", waitListSchema);
