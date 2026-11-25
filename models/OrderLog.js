/**
 * @file OrderLog - every change made from the "putting in order" pages, with what was before and what is after, collection `orderLog`
 * @module models/OrderLog
 *
 * Eden (2026-11-25): "חשוב לי גם שכל השינויים יתועדו אצלי שאני אדע מה המצב
 * הישן שהיה ומה המצב החדש".
 *
 * One row = one change, written by the server at the moment it happens:
 * who, when, what in a sentence (`text`), and the two states in words -
 * `before` and `after`, each a short list of lines the journal prints side
 * by side. `raw` keeps the same two states as data (the seat as it was, the
 * whole course with its seats before it was deleted), so that a change can
 * be put back by hand. Rows are only ever added; the super admin alone
 * reads them (/api/order/log).
 */

const mongoose = require("mongoose");

const ORDER_LOG_KINDS = ["mark", "link", "seatOff", "seatOn", "courseOff", "windows"];

const lines = { type: [{ type: String, trim: true, maxlength: 400 }], default: [] };

const orderLogSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, default: Date.now },
    by: { type: String, trim: true, default: "" },
    byAccount: { type: mongoose.Schema.Types.ObjectId, default: null },
    kind: { type: String, required: true, enum: ORDER_LOG_KINDS },
    /** whom the change is about: a person of ours, a row of the old list, or a teacher */
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", default: null },
    rid: { type: String, trim: true, default: "" },
    personName: { type: String, trim: true, maxlength: 160, default: "" },
    /** the course the change is about */
    cycle: { type: mongoose.Schema.Types.ObjectId, default: null },
    cycleName: { type: String, trim: true, maxlength: 240, default: "" },
    text: { type: String, required: true, trim: true, maxlength: 600 },
    before: lines,
    after: lines,
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { collection: "orderLog" }
);

orderLogSchema.index({ at: -1 });
orderLogSchema.index({ person: 1, at: -1 });

module.exports = mongoose.model("OrderLog", orderLogSchema);
module.exports.ORDER_LOG_KINDS = ORDER_LOG_KINDS;
