/**
 * @file Subject model - the canonical course taxonomy
 * @module models/Subject
 *
 * Today's BaseCourse, renamed and promoted: the ~17 clean subjects that
 * interests, teacher expertise, desk grouping and every cycle point at.
 * Renaming a subject renames it everywhere atomically (everything refs the
 * _id). Retire via active:false - deletion is refused while referenced.
 * The name is unique.
 */

const mongoose = require("mongoose");

const subjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "שם מקצוע הוא חובה"],
      trim: true,
    },
    /**
     * A built-in English key (domain.SUBJECT_CATEGORIES) or the id of a
     * named category (models/SubjectCategory, since 2026-10-25); Hebrew
     * labels ship from /api/meta as one merged list. The controller checks
     * the key (services/subjectCategoryService assertCategoryKey).
     */
    category: {
      type: String,
      trim: true,
      default: "other",
    },
    /**
     * Raw senzey course-name strings resolved to this subject - makes
     * re-import deterministic (resolve by data, not by regex heuristics).
     */
    importAliases: [{ type: String, trim: true }],
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

subjectSchema.index({ name: 1 }, { unique: true });
subjectSchema.index({ category: 1 });

module.exports = mongoose.model("Subject", subjectSchema);
