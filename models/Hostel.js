/**
 * @file Hostel model - the hostels as a managed entity
 * @module models/Hostel
 *
 * Replaces the free-string hostel names (+ the import-time-only HOSTELS
 * validation). Referenced by cycles.hostel (track membership),
 * cycles.venue.hostel (physical meeting place) and people.residence.hostel
 * (where a student lives). Adding a hostel = inserting a document - no
 * migration, no code change. domain.HOSTELS is now only the seed list.
 *
 * The general details (Eden, 2026-10-13: "פרטים כלליים של ההוסטל" on the
 * hostel's own page): where it is, how to reach it, who answers there,
 * and a free note. All optional - a hostel is a hostel with a name alone.
 */

const mongoose = require("mongoose");
const { WORLDS } = require("../utils/domain");

const hostelSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    name: { type: String, required: [true, "שם הוסטל הוא חובה"], trim: true },
    active: { type: Boolean, default: true },
    /** Where it is. */
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    /** How to reach the house itself. */
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    /** Who answers there - the house's own staff member, not a שק״ל person. */
    contact: {
      name: { type: String, trim: true },
      role: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

hostelSchema.index({ world: 1, name: 1 }, { unique: true });

/** The fields a PUT may change (`world` never; `name` must stay non-empty). */
hostelSchema.statics.EDITABLE = ["name", "active", "address", "city", "phone", "email", "contact", "notes"];

module.exports = mongoose.model("Hostel", hostelSchema);
