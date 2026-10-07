/**
 * @file Invoice model - a teacher's invoice (חשבונית), collection `invoices`
 * @module models/Invoice
 *
 * An invoice is a picture plus the lessons written on it (Eden, 2026-10-05:
 * "חשבונית היא תמונה + סימון השיעורים הרשומים בקובץ החשבונית"). This
 * table holds only what the invoice IS: whose, which file, when it came.
 * The lessons are rows of `invoiceLessons` (models/InvoiceLesson) - at
 * least one per invoice, enforced by services/invoiceService.
 *
 * Nothing on Person or Lesson changed for this: the invoice points at
 * them (the open/closed principle Eden asked for).
 */

const mongoose = require("mongoose");
const { WORLDS } = require("../utils/domain");

const invoiceSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: [true, "חשבונית חייבת מורה"] },
    file: { type: mongoose.Schema.Types.ObjectId, ref: "StoredFile", required: [true, "חשבונית חייבת תמונה"] },
    uploadedAt: { type: Date, default: Date.now },
    /** Persona name (no auth yet), like every other `by` in the app. */
    uploadedBy: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { timestamps: true, collection: "invoices" }
);

invoiceSchema.index({ world: 1, teacher: 1, uploadedAt: -1 });

module.exports = mongoose.model("Invoice", invoiceSchema);
