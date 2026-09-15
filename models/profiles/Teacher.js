/**
 * @file Teacher profile — מורה
 * @module models/profiles/Teacher
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");

const schema = new mongoose.Schema({
  /** THE single representation of "what the teacher teaches". */
  subjects: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
  import: {
    unmatchedSubjects: [{ type: String, trim: true }],
  },
});

schema.index({ world: 1, subjects: 1 });

module.exports = Profile.discriminator("Teacher", schema);
