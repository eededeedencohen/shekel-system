/**
 * @file ActivityTemplate model — the text a coordinator starts an activity from
 * @module models/ActivityTemplate
 *
 * The social worker (2026-10-07): "הרכזת יכולה לערוך, להוסיף ולשנות את
 * התבניות בכל עת" — so the templates are DATA, one per (world, kind),
 * edited in the app and never needing a deploy. A world without a stored
 * template for a kind gets DEFAULT_ACTIVITY_TEMPLATES (domain) — the
 * service merges the two, so this collection holds only what someone
 * changed.
 *
 * `fields` are the small structured inputs beside the free text (the
 * follow-up's attendance / motivation, the intake's four required
 * paragraphs): key, label, type (text / textarea / select / checkbox /
 * date), options for a select, and whether it is required.
 */

const mongoose = require("mongoose");
const { WORLDS, ACTIVITY_KIND_KEYS, ACTIVITY_FIELD_TYPES } = require("../utils/domain");

const fieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: ACTIVITY_FIELD_TYPES, default: "text" },
    options: [{ type: String, trim: true }],
    required: { type: Boolean, default: false },
  },
  { _id: false }
);

const activityTemplateSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    kind: { type: String, enum: ACTIVITY_KIND_KEYS, required: true },
    title: { type: String, trim: true },
    /** The opening text (questions, headings) the coordinator fills in. */
    body: { type: String, trim: true, default: "" },
    fields: { type: [fieldSchema], default: [] },
    updatedBy: { type: String, trim: true },
  },
  { timestamps: true, collection: "activityTemplates" }
);

activityTemplateSchema.index({ world: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model("ActivityTemplate", activityTemplateSchema);
