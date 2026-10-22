/**
 * @file AdminAction - one correction the super admin made, collection `adminActions`
 * @module models/AdminAction
 *
 * The state machine of the invoices (project-files/specs/hostels/
 * invoice-state-machine.html, 2026-10-22, decision 10): every reset or
 * deletion the super admin runs leaves a line - who, when, which action,
 * on what, and what happened in numbers (the same numbers the toast
 * says). A small table for one concern (Eden's rule); the supplier file's
 * corrections may write here too one day. Nothing reads it in the app yet:
 * it is the trail, read in the database explorer.
 */

const mongoose = require("mongoose");
const { WORLDS } = require("../utils/domain");

const adminActionSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    at: { type: Date, default: Date.now },
    /** The ACTING account (always the super admin himself - viewing as someone closes these). */
    actor: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true },
      kind: { type: String, trim: true },
    },
    /** "invoices" - the family the action belongs to. */
    family: { type: String, required: true, trim: true },
    /** invoiceDelete / requestReset / requestRemove / sessionsRebuild / requestsSync / roundReset / roundDelete / orphanSweep */
    action: { type: String, required: true, trim: true },
    /** What it was done on: ids with a human label ("אוקטובר 2026 · הוסטלים", "אביה טסט"). */
    targets: { type: [{ kind: String, id: String, label: String }], default: [] },
    /** What happened, in numbers. */
    did: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: false, collection: "adminActions" }
);

adminActionSchema.index({ world: 1, at: -1 });

module.exports = mongoose.model("AdminAction", adminActionSchema);
