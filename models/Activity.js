/**
 * @file Activity model - one entry of a person's record (לשונית פעילויות)
 * @module models/Activity
 *
 * The social worker (2026-10-07): "כל אירוע בחיי המתמודד מתועד בלשונית
 * הפעילויות בסדר כרונולוגי: אינטייק, שיחות מעקב, שיחות הערכה, אשפוזים
 * ועדכונים שוטפים". One row per event, one concern (the small-tables
 * rule): who, when, which kind, the text the coordinator wrote from the
 * kind's template, and the template's small fields as a plain object
 * (`fields`, validated against the template by the service).
 *
 * Two kinds restart a periodic clock when saved (domain ACTIVITY_KINDS
 * `resets`): a שיחת מעקב sets the next one three months on, a שיחת הערכה
 * two years on - lib/followups on the client reads the latest of each.
 * `program` says which program the entry belongs to when that matters
 * (a closure report, a leave report); `related` points at the row of
 * another table the entry mirrors (an incident report).
 */

const mongoose = require("mongoose");
const { WORLDS, STUDENT_KINDS, ACTIVITY_KIND_KEYS } = require("../utils/domain");

const activitySchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, index: true },
    kind: { type: String, enum: ACTIVITY_KIND_KEYS, required: true },
    /** When it happened (not when it was typed). */
    at: { type: Date, required: true, default: Date.now },
    by: { type: String, trim: true },
    title: { type: String, trim: true },
    body: { type: String, trim: true },
    /** The template's small fields - { attendance: "סדירה", motivation: "גבוהה", … }. */
    fields: { type: mongoose.Schema.Types.Mixed, default: {} },
    program: { type: String, enum: STUDENT_KINDS },
    related: {
      incident: { type: mongoose.Schema.Types.ObjectId, ref: "Incident" },
    },
    editedAt: { type: Date },
    editedBy: { type: String, trim: true },
  },
  { timestamps: true, collection: "activities" }
);

activitySchema.index({ world: 1, person: 1, at: -1 });
activitySchema.index({ world: 1, kind: 1, at: -1 });

module.exports = mongoose.model("Activity", activitySchema);
