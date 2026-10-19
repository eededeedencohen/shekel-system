/**
 * @file InvoiceRequest - one teacher's link for one month (InvoiceRound).
 *
 * `sessions` are the month's planned meetings of the teacher's courses on
 * the round's side (from the cycles' weekly slots), each with what the
 * teacher said about it: `taught` / `notHeld` / nothing yet - and, once
 * taught, the Lesson row it became (so the invoice can be written on it
 * and the coordinator's attendance report lands on the same lesson).
 *
 * The teacher's word is a draft: the coordinator's attendance report is
 * the authority (Eden, 2026-10-14); a session the teacher marked without a
 * report, or a reported one the teacher left unmarked, shows on her side.
 * @module models/InvoiceRequest
 */

const mongoose = require("mongoose");
const { WORLDS, INVOICE_SESSION_STATES } = require("../utils/domain");

const sessionSchema = new mongoose.Schema(
  {
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: "Cycle", required: true },
    /** UTC midnight of the planned day. */
    date: { type: Date, required: true },
    slotId: { type: mongoose.Schema.Types.ObjectId },
    start: { type: String, trim: true },
    end: { type: String, trim: true },
    state: { type: String, enum: [...INVOICE_SESSION_STATES, null], default: null },
    markedAt: { type: Date },
    lesson: { type: mongoose.Schema.Types.ObjectId, ref: "Lesson", default: null },
  },
  { _id: true }
);

const invoiceRequestSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    round: { type: mongoose.Schema.Types.ObjectId, ref: "InvoiceRound", required: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true },
    token: { type: String, required: true, trim: true },
    expiresAt: { type: Date, required: true },
    sentAt: { type: Date },
    sentBy: { type: String, trim: true },
    openedAt: { type: Date },
    lastOpenedAt: { type: Date },
    completedAt: { type: Date },
    sessions: { type: [sessionSchema], default: [] },
    /** What the teacher wrote on the way out ("לימדתי גם ב-3.10 במקום 1.10"). */
    note: { type: String, trim: true },
  },
  { timestamps: true, collection: "invoiceRequests" }
);

invoiceRequestSchema.index({ world: 1, token: 1 }, { unique: true });
invoiceRequestSchema.index({ round: 1, teacher: 1 }, { unique: true });

invoiceRequestSchema.methods.linkLive = function () {
  return !!this.expiresAt && this.expiresAt.getTime() > Date.now();
};

module.exports = mongoose.model("InvoiceRequest", invoiceRequestSchema);
