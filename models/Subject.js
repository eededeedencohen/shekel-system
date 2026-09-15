/**
 * @file Subject model — the canonical course taxonomy
 * @module models/Subject
 *
 * Today's BaseCourse, renamed and promoted: the ~17 clean subjects that
 * interests, teacher expertise, desk grouping and every cycle point at.
 * Renaming a subject renames it everywhere atomically (everything refs the
 * _id). Retire via active:false — deletion is refused while referenced.
 *
 * Demo worlds hold their own copies/clones ({world,name} unique), so world
 * isolation has no special cases.
 */

const mongoose = require("mongoose");
const { WORLDS, SUBJECT_CATEGORY_KEYS } = require("../utils/domain");

const subjectSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    name: {
      type: String,
      required: [true, "שם מקצוע הוא חובה"],
      trim: true,
    },
    /** English key (domain.SUBJECT_CATEGORIES); Hebrew labels ship from /api/meta. */
    category: {
      type: String,
      enum: SUBJECT_CATEGORY_KEYS,
      default: "other",
    },
    /**
     * Raw senzey course-name strings resolved to this subject — makes
     * re-import deterministic (resolve by data, not by regex heuristics).
     */
    importAliases: [{ type: String, trim: true }],
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

subjectSchema.index({ world: 1, name: 1 }, { unique: true });
subjectSchema.index({ world: 1, category: 1 });

module.exports = mongoose.model("Subject", subjectSchema);
