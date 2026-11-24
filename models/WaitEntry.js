/**
 * @file WaitEntry - one person waiting in one list (models/WaitList). A
 * person may wait in several lists: a row each.
 *
 * WHO waits is a person of the system (`person`) or, when the system does
 * not know them yet, only the name as it was written (`name`) - Eden,
 * 2026-11-24: "אם יש סטודנטים קיימים… תן להם רפרנס, אבל אם לא קיימים אז
 * תשאיר להם כרטיס… שיהיה ברור". Linking a name to a person later is one
 * field. The queue is `rank`, ascending; a row that left the queue keeps
 * its rank, so "back to the list" returns it to where it stood.
 * @module models/WaitEntry
 */

const mongoose = require("mongoose");

/** How many courses the person wants at once - what the question after a placement leans on. */
const WAIT_WANTS = ["one", "two", "many"];
/** Why a row left the queue: placed here, placed in another list's course, asked to leave, no answer, no longer relevant. */
const WAIT_END_REASONS = ["placed", "elsewhere", "asked", "noAnswer", "irrelevant"];

const waitEntrySchema = new mongoose.Schema(
  {
    list: { type: mongoose.Schema.Types.ObjectId, ref: "WaitList", required: true, index: true },
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", default: null, index: true },
    /** The name as written (the only identity of whoever is not in the system; a snapshot for whoever is). */
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    /** The words beside the name: the instrument, the hours. */
    note: { type: String, trim: true, maxlength: 200, default: "" },
    /** Already learns a course and waits for one more - said by hand for whoever is not in the system. */
    learning: { type: Boolean, default: false },
    wants: { type: String, enum: [...WAIT_WANTS, null], default: null },
    rank: { type: Number, default: 0 },
    /** When the wait began - null for a row that came from the old sheet, which held no dates. */
    since: { type: Date, default: null },
    source: { type: String, enum: ["app", "sheet"], default: "app" },
    addedBy: { type: String, trim: true },
    /** The last time the row was moved by hand in its queue, and why. */
    moved: {
      at: { type: Date },
      by: { type: String, trim: true },
      why: { type: String, trim: true, maxlength: 200 },
    },
    state: { type: String, enum: ["waiting", "placed", "left"], default: "waiting", index: true },
    endReason: { type: String, enum: [...WAIT_END_REASONS, null], default: null },
    endNote: { type: String, trim: true, maxlength: 200, default: "" },
    endedAt: { type: Date, default: null },
    endedBy: { type: String, trim: true },
    /** The course the person was placed in, when one was named. */
    course: { type: mongoose.Schema.Types.ObjectId, ref: "Cycle", default: null },
  },
  { timestamps: true, collection: "waitEntries" }
);

waitEntrySchema.index({ list: 1, state: 1, rank: 1 });

const WaitEntry = mongoose.model("WaitEntry", waitEntrySchema);
WaitEntry.WAIT_WANTS = WAIT_WANTS;
WaitEntry.WAIT_END_REASONS = WAIT_END_REASONS;

module.exports = WaitEntry;
