/**
 * @file StoredFile model - a file of the app (collection `files`)
 * @module models/StoredFile
 *
 * The first table of the small-tables model (Eden, 2026-10-05): one thing,
 * one table. Who a file belongs to is written on the table that points
 * here (an intake document row, a supplier's certificate row, a person
 * document, an invoice, a voucher, a book cover) - and, since 2026-10-26,
 * here too (`family`, `owner`), so an access check can start from the file.
 *
 * WHERE THE BYTES ARE (the S3 move, 2026-10-26, project-files/specs/
 * files-s3-plan.html): a new file lives in the private bucket under
 * `storageKey` (its thumbnail under `thumbKey`) and the row holds the
 * facts only; a file from before still carries `data` / `thumb` until the
 * migration script moved it. `status` is "pending" between the signed
 * upload and the server's confirmation (HeadObject: size and type), then
 * "ready". JSON never carries bytes.
 */

const mongoose = require("mongoose");

const FILE_FAMILIES = ["intake", "waiver", "suppliers", "people", "invoices", "culture", "library"];
const FILE_STATUSES = ["pending", "ready"];

const storedFileSchema = new mongoose.Schema(
  {
    /** The name it was uploaded under (display only). */
    name: { type: String, trim: true },
    mime: { type: String, required: true, trim: true },
    size: { type: Number, min: 0 },
    /** Legacy: the bytes in the database (files from before the S3 move). */
    data: { type: Buffer },
    /**
     * Legacy: a small JPEG of the file (≤ 256KB) the uploader rendered - an
     * image shrunk, a PDF's first page - so a list can show what the file
     * looks like without pulling the bytes (2026-10-11).
     */
    thumb: { type: Buffer },
    savedAt: { type: Date, default: Date.now },

    /* ── the bucket (2026-10-26) ── */
    /** `<family>/<ownerId>/<uuid>` - not guessable, never derived from the name. */
    storageKey: { type: String, trim: true },
    /** The thumbnail's key (`<storageKey>.thumb.jpg`), when the uploader sent one. */
    thumbKey: { type: String, trim: true },
    thumbSize: { type: Number, min: 0 },
    status: { type: String, enum: FILE_STATUSES, default: "ready" },
    /** Which part of the app the file belongs to - the family gate (utils/auth FAMILIES) is read from it. */
    family: { type: String, enum: FILE_FAMILIES },
    /** The record the file hangs on: kind (intake / supplier / person / invoice / voucher / book), its id, the slot (a document key, a certificate key). */
    owner: {
      kind: { type: String, trim: true },
      id: { type: mongoose.Schema.Types.ObjectId },
      slot: { type: String, trim: true },
    },
    /** When the file was attached to its record (a confirmed but never attached file is an orphan the janitor may drop). */
    attachedAt: { type: Date },
    /** An explicit grant to a staff account on top of the lens (empty by default). */
    allowedAccounts: [{ type: mongoose.Schema.Types.ObjectId, ref: "StaffAccount" }],
    /** Who uploaded: the acting account and its name, or the public link's kind (never a value from the request body). */
    uploadedBy: {
      account: { type: mongoose.Schema.Types.ObjectId, ref: "StaffAccount" },
      label: { type: String, trim: true },
      token: { type: String, trim: true },
    },
  },
  { timestamps: true, collection: "files" }
);

storedFileSchema.index({ storageKey: 1 }, { unique: true, sparse: true });
storedFileSchema.index({ family: 1, "owner.id": 1 });
storedFileSchema.index({ status: 1, createdAt: 1 });

function stripData(doc, ret) {
  delete ret.data;
  delete ret.thumb;
  return ret;
}
storedFileSchema.set("toJSON", { transform: stripData });
storedFileSchema.set("toObject", { transform: stripData });

const StoredFile = mongoose.model("StoredFile", storedFileSchema);
StoredFile.FAMILIES = FILE_FAMILIES;
module.exports = StoredFile;
