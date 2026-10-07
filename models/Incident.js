/**
 * @file Incident model - דיווח אירוע חריג
 * @module models/Incident
 *
 * The Ministry of Health procedure the social worker described
 * (2026-10-07): the exact date and time, who reported and in what role,
 * a primary and a secondary classification, a factual description, the
 * immediate actions taken, and the report to a manager. One row per
 * incident; the person's activities tab mirrors it as an "incident"
 * activity (services/incidentService writes both).
 */

const mongoose = require("mongoose");
const { WORLDS, INCIDENT_PRIMARY_KEYS } = require("../utils/domain");

const incidentSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, index: true },
    /** When it happened - date AND time. */
    at: { type: Date, required: true },
    reportedBy: {
      name: { type: String, trim: true, required: true },
      role: { type: String, trim: true },
    },
    primary: { type: String, enum: INCIDENT_PRIMARY_KEYS, required: true },
    secondary: { type: String, trim: true },
    /** Facts only. */
    description: { type: String, trim: true, required: true },
    /** What was done at once. */
    actions: { type: String, trim: true },
    managerNotified: {
      name: { type: String, trim: true },
      at: { type: Date },
    },
    /** The activity row that mirrors this incident on the person's record. */
    activity: { type: mongoose.Schema.Types.ObjectId, ref: "Activity" },
    by: { type: String, trim: true },
  },
  { timestamps: true, collection: "incidents" }
);

incidentSchema.index({ world: 1, at: -1 });

module.exports = mongoose.model("Incident", incidentSchema);
