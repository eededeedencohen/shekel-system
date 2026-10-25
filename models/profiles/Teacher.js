/**
 * @file Teacher profile - מורה
 * @module models/profiles/Teacher
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");

const schema = new mongoose.Schema({
  /** THE single representation of "what the teacher teaches". */
  subjects: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
  /** ₪ per session in the hostels (שמרית's file, 2026-10-19: "שכר למורים") - the invoice round checks the sum against it. */
  hostelRate: { type: Number, min: 0 },
  import: {
    unmatchedSubjects: [{ type: String, trim: true }],
  },
});

schema.index({ subjects: 1 });

module.exports = Profile.discriminator("Teacher", schema);
