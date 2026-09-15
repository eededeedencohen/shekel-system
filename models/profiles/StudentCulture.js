/**
 * @file StudentCulture profile — סטודנט/ית תרבות לכל
 * @module models/profiles/StudentCulture
 *
 * Same student skeleton (own pipeline!), its own fields. Kept minimal
 * until the culture department's flows are specified — extend freely,
 * nothing else in the system names this kind.
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");
const { studentCorePaths, applyStudentCore } = require("./studentCore");
const { EVENT_CATEGORY_KEYS } = require("../../utils/domain");

const schema = new mongoose.Schema({
  ...studentCorePaths,
  /** Subjects/activities of interest for culture outings. */
  interests: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
  /** The kinds of outings they like (landing page) — event category keys. */
  preferredCategories: [{ type: String, enum: EVENT_CATEGORY_KEYS }],
  emergencyContact: { type: String, trim: true },
  emergencyPhone: { type: String, trim: true },
  /** The rehabilitation coordinator on the senzey card (same shape as the college profile). */
  caseCoordinator: {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    organization: { type: String, trim: true },
  },
  /** Department-specific example field (billing handled per enrollment). */
  billingNotes: { type: String, trim: true },
  /** Raw senzey import text — display-only, never matched on (scripts/lib/senzeyCulture.js). */
  import: {
    statusLabel: { type: String, trim: true },
    clientType: { type: String, trim: true },
    framework: { type: String, trim: true },
    residence: { type: String, trim: true },
    source: { type: String, trim: true },
  },
});

applyStudentCore(schema);

module.exports = Profile.discriminator("StudentCulture", schema);
