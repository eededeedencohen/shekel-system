/**
 * @file StudentCollege profile — סטודנט/ית מכללה לכל
 * @module models/profiles/StudentCollege
 *
 * Carries everything the old Person "Student" discriminator held: the
 * college intake pipeline, the matching profile, residence and the case
 * coordinator. The senzey import quarantine moved here with it.
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");
const { studentCorePaths, applyStudentCore } = require("./studentCore");
const { FUNCTIONING_LEVELS, GROUP_PREFERENCES } = require("../../utils/domain");

const schema = new mongoose.Schema({
  ...studentCorePaths,
  matching: {
    functioningLevel: { type: String, enum: FUNCTIONING_LEVELS },
    groupPreference: { type: String, enum: GROUP_PREFERENCES },
    /** Real Subject refs — matched on, never free strings. */
    interests: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
  },
  /** Where the student LIVES: ref when it's one of the hostels, plus the
   *  raw imported framework text for display. */
  residence: {
    hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel" },
    label: { type: String, trim: true },
  },
  address: { type: String, trim: true },
  city: { type: String, trim: true },
  emergencyContact: { type: String, trim: true },
  emergencyPhone: { type: String, trim: true },
  caseCoordinator: {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    organization: { type: String, trim: true },
  },
  /** Raw senzey import text — display-only, never matched on. */
  import: {
    statusLabel: { type: String, trim: true },
    typeTags: [{ type: String, trim: true }],
    registrationSource: { type: String, trim: true },
    openedBy: { type: String, trim: true },
    unmatchedInterests: [{ type: String, trim: true }],
  },
});

applyStudentCore(schema);
schema.index({ world: 1, "matching.interests": 1 });
schema.index({ world: 1, "residence.hostel": 1 });

module.exports = Profile.discriminator("StudentCollege", schema);
