/**
 * @file CycleTag model - the program a cycle belongs to
 * @module models/CycleTag
 *
 * A row per tag of a cycle (collection `cycleTags`). Today every cycle
 * carries exactly one program tag - מכללה לכל or הוסטלים (a hostel's
 * course is NOT a college course: Eden, 2026-10-05) - and the hostel
 * itself stays on the cycle until that column moves to its own table.
 */

const mongoose = require("mongoose");

const cycleTagSchema = new mongoose.Schema(
  {
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: "Cycle", required: true },
    tag: { type: mongoose.Schema.Types.ObjectId, ref: "Tag", required: true },
  },
  { timestamps: true, collection: "cycleTags" }
);
cycleTagSchema.index({ cycle: 1, tag: 1 }, { unique: true });
cycleTagSchema.index({ tag: 1 });

module.exports = mongoose.model("CycleTag", cycleTagSchema);
