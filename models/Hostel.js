/**
 * @file Hostel model — the hostels as a managed entity
 * @module models/Hostel
 *
 * Replaces the free-string hostel names (+ the import-time-only HOSTELS
 * validation). Referenced by cycles.hostel (track membership),
 * cycles.venue.hostel (physical meeting place) and people.residence.hostel
 * (where a student lives). Adding a hostel = inserting a document — no
 * migration, no code change. domain.HOSTELS is now only the seed list.
 */

const mongoose = require("mongoose");
const { WORLDS } = require("../utils/domain");

const hostelSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    name: { type: String, required: [true, "שם הוסטל הוא חובה"], trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

hostelSchema.index({ world: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Hostel", hostelSchema);
