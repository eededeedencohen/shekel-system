/**
 * @file StoredFile model - a file kept IN the database (collection `files`)
 * @module models/StoredFile
 *
 * The first table of the small-tables model (Eden, 2026-10-05): one thing,
 * one table. A file is bytes + what they are; who it belongs to is written
 * on the table that points here (an invoice, later a cover or an intake
 * document). The bytes live in the database because the server's disk is
 * wiped on every deploy.
 *
 * JSON never carries the bytes - a route streams them (see getImage in
 * controllers/invoiceController).
 */

const mongoose = require("mongoose");
const { WORLDS } = require("../utils/domain");

const storedFileSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    /** The name it was uploaded under (display only). */
    name: { type: String, trim: true },
    mime: { type: String, required: true, trim: true },
    size: { type: Number, min: 0 },
    data: { type: Buffer, required: true },
    /**
     * A small JPEG of the file (≤ 256KB) the uploader rendered - an image
     * shrunk, a PDF's first page - so a list can show what the file looks
     * like without pulling the bytes (2026-10-11). Streamed by its own
     * route; absent for Word files and uploads from before.
     */
    thumb: { type: Buffer },
    savedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: "files" }
);

function stripData(doc, ret) {
  delete ret.data;
  delete ret.thumb;
  return ret;
}
storedFileSchema.set("toJSON", { transform: stripData });
storedFileSchema.set("toObject", { transform: stripData });

module.exports = mongoose.model("StoredFile", storedFileSchema);
