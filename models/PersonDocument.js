/**
 * @file PersonDocument - a paper of one person's own: a teacher's syllabus
 * first (שמרית, 2026-10-14: "כל מורה יצטרך לתת לנו סילבוס… תחת מורים, כל
 * אחד את הסילבוס שלו, את הניירת שלו"). Small-tables rule: one concern,
 * one row per file; the bytes live in `files` (StoredFile), the row says
 * whose, what and when.
 * @module models/PersonDocument
 */

const mongoose = require("mongoose");
const { PERSON_DOCUMENT_KIND_KEYS } = require("../utils/domain");

const personDocumentSchema = new mongoose.Schema(
  {
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, index: true },
    kind: { type: String, enum: PERSON_DOCUMENT_KIND_KEYS, required: true, default: "other" },
    /** What the staff called it ("סילבוס תשפ״ז"); the kind's label when empty. */
    label: { type: String, trim: true },
    file: { type: mongoose.Schema.Types.ObjectId, ref: "StoredFile", required: true },
    name: { type: String, trim: true },
    mime: { type: String, trim: true },
    size: { type: Number, min: 0 },
    /** The stored file carries a thumbnail (the client made one for an image / a PDF's first page). */
    thumb: { type: Boolean, default: false },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { timestamps: true, collection: "personDocuments" }
);

personDocumentSchema.index({ person: 1, uploadedAt: -1 });

module.exports = mongoose.model("PersonDocument", personDocumentSchema);
