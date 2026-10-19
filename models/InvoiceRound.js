/**
 * @file InvoiceRound - one month of one program's teacher invoices
 * (שמרית's round, 2026-10-14: at the month's end every teacher gets a
 * temporary link, marks the sessions that took place, uploads the
 * invoice; the coordinator watches who finished and sends the mail).
 *
 * The round is the month; the teachers' links are InvoiceRequest rows
 * (one per teacher). `mail.sentAt` closes the month on the coordinator's
 * side: the PDFs went to the bookkeeping.
 * @module models/InvoiceRound
 */

const mongoose = require("mongoose");
const { WORLDS, INVOICE_ROUND_PROGRAMS } = require("../utils/domain");

const invoiceRoundSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    /** "2026-10" */
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    program: { type: String, enum: INVOICE_ROUND_PROGRAMS, required: true, default: "hostels" },
    openedAt: { type: Date, default: Date.now },
    openedBy: { type: String, trim: true },
    mail: {
      sentAt: { type: Date },
      sentBy: { type: String, trim: true },
    },
    note: { type: String, trim: true },
  },
  { timestamps: true, collection: "invoiceRounds" }
);

invoiceRoundSchema.index({ world: 1, program: 1, month: 1 }, { unique: true });

module.exports = mongoose.model("InvoiceRound", invoiceRoundSchema);
