/**
 * @file SubjectCategory model - a category of the course catalogue that the
 * staff named themselves
 * @module models/SubjectCategory
 *
 * The catalogue's categories are the built-in list in utils/domain
 * (SUBJECT_CATEGORIES - מוזיקה, אומנות…) PLUS these rows. Eden (2026-10-25):
 * a new course must have a category, and marking "אחר" means naming a NEW
 * one - "אם היא תסמן על קטגוריה אחר היא חייבת לתת לזה שם". A row's key on
 * the wire is its id string, so `Subject.category` holds either a built-in
 * English key or a row id; /api/meta/domain serves both lists as one
 * (services/subjectCategoryService allCategories).
 *
 * One small single-concern table (Eden's rule); the label is unique.
 */

const mongoose = require("mongoose");

const subjectCategorySchema = new mongoose.Schema(
  {
    label: { type: String, required: [true, "לקטגוריה צריך שם"], trim: true, maxlength: [60, "שם הקטגוריה ארוך מדי"] },
    active: { type: Boolean, default: true },
    createdBy: { type: String, trim: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/** The key a Subject stores and the client groups by - the id as a string. */
subjectCategorySchema.virtual("key").get(function key() {
  return String(this._id);
});

subjectCategorySchema.index({ label: 1 }, { unique: true });

module.exports = mongoose.model("SubjectCategory", subjectCategorySchema);
