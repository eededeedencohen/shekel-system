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

const invoiceSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: [true, "חשבונית חייבת מורה"] },
    file: { type: mongoose.Schema.Types.ObjectId, ref: "StoredFile", required: [true, "חשבונית חייבת תמונה"] },
    uploadedAt: { type: Date, default: Date.now },
    /** Persona name (no auth yet), like every other `by` in the app. */
    uploadedBy: { type: String, trim: true },
    note: { type: String, trim: true },
    /** Set when the teacher uploaded it through a month's link (InvoiceRequest); null = the staff uploaded it. */
    request: { type: mongoose.Schema.Types.ObjectId, ref: "InvoiceRequest", default: null },
    /**
     * What the paper says (Eden, 2026-11-10): its own number ("מספר
     * חשבונית" - the coordinator's ledger lives on it) and its sum in ₪
     * including VAT. Typed by the teacher behind the check link, or by the
     * coordinator ("שמרית משייכת מספר לחשבוניות שהעלו"); `declaredBy` says
     * who last did.
     */
    number: { type: String, trim: true },
    amount: { type: Number, min: 0 },
    declaredBy: { type: String, enum: ["teacher", "staff", null], default: null },
    declaredAt: { type: Date },
    /**
     * The sum the lessons on it should carry, as computed when the sum was
     * declared (hours × the hourly rate, or sessions × the per-session
     * rate), and the verdict: match / low / high (INVOICE_CHECK_VERDICTS),
     * `unknown` when the teacher had no rate. A snapshot - the rate may
     * change later; the staff view also computes live.
     */
    check: {
      expected: { type: Number },
      hours: { type: Number },
      sessions: { type: Number },
      missingHours: { type: Number },
      rate: { type: Number },
      rateKind: { type: String, enum: ["hour", "session", null], default: null },
      verdict: { type: String, enum: ["match", "low", "high", "unknown", null], default: null },
      diff: { type: Number },
    },
    /** The teacher's word on a sum that differs: a quick reason (INVOICE_DIFF_REASONS) and/or free text. */
    explanation: {
      reason: { type: String, trim: true },
      text: { type: String, trim: true },
    },
  },
  { timestamps: true, collection: "invoices" }
);

invoiceSchema.index({ teacher: 1, uploadedAt: -1 });
invoiceSchema.index({ request: 1 });

module.exports = mongoose.model("Invoice", invoiceSchema);
