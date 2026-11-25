/**
 * @file OrderMark - what the college's staff said of one student while putting the lists in order, collection `orderMarks`
 * @module models/OrderMark
 *
 * Eden (2026-11-25): "תיצור לי ולנעה וחגיי עמוד שבו אנחנו נעשה סדר עם
 * הסטודנטים… לכל רשומה יהיו פעולות של - שייך למכללה לכל, עזב את שקל, אחר
 * (אחר יפתח מודל עם מקום לטקסט חופשי)".
 *
 * One row = one line of the page's list and the one thing said of it. The
 * line is a person of ours (`person`), a row of the old system's students
 * list (`rid`), or both when the two are one person. `key` names the line:
 * "p:<person id>" for a person of ours, "s:<rid>" for a row of the old list
 * alone. A mark is a WORD about the person - it changes nothing of the
 * person's own record; what is done with the words is decided after.
 *
 * `same` is the other thing a line can be told: that a person of ours and a
 * row of the old list, which only look alike, are one person (true) or two
 * (false) - kept on the row "l:<rid>:<person id>".
 */

const mongoose = require("mongoose");

const ORDER_DECISIONS = ["college", "left", "other"];

const orderMarkSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", default: null },
    /** the row's number in the old system's students list */
    rid: { type: String, trim: true, default: "" },
    /** the name as the page showed it when the word was said */
    name: { type: String, trim: true, maxlength: 160, default: "" },
    decision: { type: String, enum: [...ORDER_DECISIONS, null], default: null },
    /** the free words of "אחר" */
    note: { type: String, trim: true, maxlength: 800, default: "" },
    /** "the two are one person" (true) / "two people" (false) - on a link row alone */
    same: { type: Boolean, default: null },
    by: { type: String, trim: true, default: "" },
    at: { type: Date, default: null },
  },
  { timestamps: true, collection: "orderMarks" }
);

orderMarkSchema.index({ person: 1 });

module.exports = mongoose.model("OrderMark", orderMarkSchema);
module.exports.ORDER_DECISIONS = ORDER_DECISIONS;
