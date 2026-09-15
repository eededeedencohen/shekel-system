/**
 * @file Loan model — a book with a student (הספרייה)
 * @module models/Loan
 *
 * One document per loan: who took which book, when, until when, and (once
 * closed) when it came back. `open` is true while the book is out — it
 * carries the ONE-COPY invariant as a partial unique index on
 * (world, book, open:true): a second open loan of the same book is refused
 * by the database itself, whatever the caller did.
 *
 * Extensions (הארכת זמן) append to `extensions` and move `dueAt`; the
 * original date stays in the first row so the history reads naturally.
 * Every step is also logged (`log`) with the acting persona name — no
 * auth yet, like the rest of the pipeline.
 */

const mongoose = require("mongoose");
const { WORLDS, LOAN_LOG_ACTIONS } = require("../utils/domain");

const extensionSchema = new mongoose.Schema(
  {
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    at: { type: Date, default: Date.now },
    by: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const logEntrySchema = new mongoose.Schema(
  {
    action: { type: String, enum: LOAN_LOG_ACTIONS, required: true },
    at: { type: Date, default: Date.now },
    by: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const loanSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    book: { type: mongoose.Schema.Types.ObjectId, ref: "Book", required: true, immutable: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, immutable: true },
    /** true while the book is out; false once returned. */
    open: { type: Boolean, default: true, index: true },
    loanedAt: { type: Date, default: Date.now },
    /** Local midnight of the agreed return day (never Fri/Sat). */
    dueAt: { type: Date, required: true },
    returnedAt: { type: Date },
    /** Persona names. */
    by: { type: String, trim: true },
    returnedBy: { type: String, trim: true },
    note: { type: String, trim: true },
    extensions: { type: [extensionSchema], default: [] },
    log: { type: [logEntrySchema], default: [] },
  },
  { timestamps: true, collection: "loans" }
);

/** ONE copy per book: at most one open loan of a book per world. */
loanSchema.index(
  { world: 1, book: 1 },
  { unique: true, partialFilterExpression: { open: true } }
);
loanSchema.index({ world: 1, student: 1, open: 1 });
loanSchema.index({ world: 1, open: 1, dueAt: 1 });

module.exports = mongoose.model("Loan", loanSchema);
