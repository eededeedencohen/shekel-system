/**
 * @file Teacher profile - מורה
 * @module models/profiles/Teacher
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");

const schema = new mongoose.Schema({
  /** THE single representation of "what the teacher teaches". */
  subjects: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
  /** ₪ per session in the hostels (שמרית's file, 2026-10-19: "שכר למורים") - the invoice round checks the sum against it. */
  hostelRate: { type: Number, min: 0 },
  /**
   * The bookkeeping's facts of the freelancer (her "פרילנסרים" sheet, Eden
   * 2026-11-10: "לשלב את החלק הזה של השכר השעתי"): ₪ per hour INCLUDING
   * VAT ("תעריף לשעה כולל מע"מ"), the supplier's number in the ERP
   * ("מספר ספק"), the year's framework purchase order ("מספר הזמנת רכש")
   * and the monthly hours of the frame ("שעות חודשיות"). The invoice round
   * computes the expected sum of a month from the hourly rate first; the
   * per-session hostels rate is the fallback.
   */
  hourlyRate: { type: Number, min: 0 },
  /**
   * How the hour is paid (Eden, 2026-11-18): `fixed` - one rate, `hourlyRate`;
   * `format` - one rate for a private lesson and another for a group
   * (`ratePrivate` / `rateGroup`, a cycle's matching.format says which);
   * `count` - by how many students sit in the lesson (`rateTiers`: from that
   * many students and up, this much an hour - the first tier starts at 1).
   * All of them ₪ per hour including VAT, like `hourlyRate`.
   */
  rateMode: { type: String, enum: ["fixed", "format", "count"], default: "fixed" },
  ratePrivate: { type: Number, min: 0 },
  rateGroup: { type: Number, min: 0 },
  rateTiers: {
    type: [{ _id: false, from: { type: Number, min: 1, required: true }, value: { type: Number, min: 0, required: true } }],
    default: undefined,
    validate: {
      validator: (list) => !list || !list.length || (list[0].from === 1 && list.every((t, i) => Number.isInteger(t.from) && (i === 0 || t.from > list[i - 1].from)) && list.length <= 12),
      message: "מדרגות התעריף: הראשונה מסטודנט אחד, וכל מדרגה ממספר גדול מקודמתה",
    },
  },
  supplierNumber: { type: String, trim: true },
  purchaseOrder: { type: String, trim: true },
  monthlyHours: { type: Number, min: 0 },
  import: {
    unmatchedSubjects: [{ type: String, trim: true }],
  },
});

schema.index({ subjects: 1 });

module.exports = Profile.discriminator("Teacher", schema);
