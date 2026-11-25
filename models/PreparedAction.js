/**
 * @file PreparedAction - a change to the data that waits for the super admin's approval, collection `preparedActions`
 * @module models/PreparedAction
 *
 * Eden (2026-11-25): "אני רוצה שתיצור לי עמוד בשם פעולות מוכנות. אתה יוצר
 * פעולה ומתאר מה יהיה בפעולה ואני מתבונן ולוחץ אישור - כשאני לוחץ אישור אז
 * הפעולה מתבצעת".
 *
 * One row = one action: what it is in words (`title`, `summary`, where its
 * facts come from - `source`, what was left out and why - `notes`), and its
 * STEPS in order. A step is one small thing the app itself knows how to do
 * (services/preparedActionService KINDS: a teacher, a subject, a student, a
 * course, a seat); its `data` is what it needs, and may point at an earlier
 * step ("$s1" = whatever that step made or found). Nothing happens until he
 * presses approve; then the steps run one after another through the app's
 * own services, and each keeps its `outcome` - made, found (already there,
 * nothing changed), skipped, failed - with the record it touched.
 *
 * Real people's names stand in a row here and nowhere in the code: the rows
 * are behind the super admin's door (/api/prepared-actions, requireSuper).
 */

const mongoose = require("mongoose");

const ACTION_STATES = ["ready", "running", "done", "partial", "cancelled"];
const STEP_KINDS = ["teacher", "subject", "student", "cycle", "seat"];
const OUTCOMES = ["made", "found", "skipped", "failed"];

const stepSchema = new mongoose.Schema(
  {
    /** the step's name inside its action ("s1"): what a later step points at as "$s1" */
    id: { type: String, required: true, trim: true, maxlength: 20 },
    kind: { type: String, required: true, enum: STEP_KINDS },
    /** what the step does, in words, as the page says it */
    label: { type: String, required: true, trim: true, maxlength: 240 },
    /** a line under it: where the fact comes from, what is not known */
    detail: { type: String, trim: true, maxlength: 400, default: "" },
    /** what the step needs (services/preparedActionService says which fields each kind reads) */
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** a step he may leave out before approving; `on` = whether it runs unless he says otherwise */
    optional: { type: Boolean, default: false },
    on: { type: Boolean, default: true },
    outcome: {
      status: { type: String, enum: [...OUTCOMES, null], default: null },
      /** the record the step made or found: its id, and which page shows it */
      ref: { type: String, default: "" },
      refKind: { type: String, default: "" },
      message: { type: String, trim: true, maxlength: 400, default: "" },
      at: { type: Date, default: null },
    },
  },
  { _id: false }
);

const preparedActionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    summary: { type: String, trim: true, maxlength: 2000, default: "" },
    source: { type: String, trim: true, maxlength: 600, default: "" },
    notes: { type: [{ type: String, trim: true, maxlength: 600 }], default: [] },
    steps: { type: [stepSchema], default: [] },
    status: { type: String, enum: ACTION_STATES, default: "ready", index: true },
    createdBy: { type: String, trim: true, maxlength: 80, default: "" },
    approvedBy: { type: String, trim: true, maxlength: 80, default: "" },
    approvedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "preparedActions" }
);

preparedActionSchema.index({ createdAt: -1 });

module.exports = mongoose.model("PreparedAction", preparedActionSchema);
module.exports.ACTION_STATES = ACTION_STATES;
module.exports.STEP_KINDS = STEP_KINDS;
