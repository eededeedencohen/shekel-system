/**
 * @file UploadLink model - a temporary link for uploading documents
 * @module models/UploadLink
 *
 * The social worker (2026-10-07): the candidate never signs in; the
 * coordinator makes a link (10 minutes / half an hour / an hour / a day),
 * sends it on WhatsApp, and after that time the link is locked. One row
 * per link, pointing at the intake it uploads into; `docs` narrows it to
 * particular documents (empty = every document that is still open).
 *
 * The public page resolves a token here first, then falls back to the
 * landing page's personal link (which expires on its own clock).
 */

const mongoose = require("mongoose");
const { WORLDS, INTAKE_DOCUMENT_KEYS } = require("../utils/domain");

const uploadLinkSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    intake: { type: mongoose.Schema.Types.ObjectId, ref: "Intake", required: true, index: true },
    token: { type: String, required: true, trim: true, unique: true },
    expiresAt: { type: Date, required: true },
    /** How long it was made for, in minutes (what the coordinator picked). */
    minutes: { type: Number, min: 1 },
    docs: [{ type: String, enum: INTAKE_DOCUMENT_KEYS }],
    createdBy: { type: String, trim: true },
    /** Every upload through this link (the audit the coordinator sees). */
    usedAt: { type: [Date], default: [] },
    note: { type: String, trim: true },
  },
  { timestamps: true, collection: "uploadLinks" }
);

uploadLinkSchema.index({ world: 1, intake: 1, expiresAt: -1 });

/** Still open right now? */
uploadLinkSchema.methods.isLive = function () {
  return this.expiresAt && this.expiresAt.getTime() > Date.now();
};

module.exports = mongoose.model("UploadLink", uploadLinkSchema);
