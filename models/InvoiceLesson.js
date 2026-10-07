/**
 * @file InvoiceLesson model - one lesson written on one invoice
 * @module models/InvoiceLesson
 *
 * A row per lesson on an invoice (collection `invoiceLessons`). The unique
 * index on `lesson` is the rule "a lesson is billed once": a second invoice
 * naming the same lesson is refused by the database itself, whatever the
 * write path. "At least one lesson per invoice" is the service's rule
 * (the database cannot count).
 */

const mongoose = require("mongoose");
const { WORLDS } = require("../utils/domain");

const invoiceLessonSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    lesson: { type: mongoose.Schema.Types.ObjectId, ref: "Lesson", required: true },
  },
  { timestamps: true, collection: "invoiceLessons" }
);

invoiceLessonSchema.index({ lesson: 1 }, { unique: true });
invoiceLessonSchema.index({ invoice: 1 });

module.exports = mongoose.model("InvoiceLesson", invoiceLessonSchema);
