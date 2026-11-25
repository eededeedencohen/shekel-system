/**
 * WeekPlan - a hostels teacher's fixed week, in the teacher's own words
 * (Eden, 2026-11-18: "יש לי בלאגן עם הקורסים של ההוסטלים… סוג של טופס שיהיה
 * קל למורים לסמן את הלו״ז השבועי שלהם א-ה: איזה שיעור הם מלמדים, טווח
 * השעות, של איזה הוסטל, ומיקום (בהוסטל / בשק״ל)").
 *
 * A TEMPORARY census beside the real data: nothing here touches a course,
 * a cycle or a seat ("לא להחליף את הקיים בחדש כי זה נעשה אח״כ ביחד"). One
 * row a teacher: the personal link (token, the day it closes, when it was
 * sent, opened and handed in) and the entries of the week - each one
 * written by the teacher through the link or by the staff on their page,
 * and stamped with who wrote it.
 *
 * A form can also be ONE person's for several teachers (`covers`): then each
 * lesson names its teacher. And what was written before a fresh start is set
 * `aside`, kept but not counted.
 */

const mongoose = require("mongoose");

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const entrySchema = new mongoose.Schema(
  {
    /** 0 = Sunday … 4 = Thursday */
    day: { type: Number, min: 0, max: 4, required: true },
    start: { type: String, match: HHMM, required: true },
    end: { type: String, match: HHMM, required: true },
    /** what is taught, as it was written (a name, not a link to the catalogue) */
    subject: { type: String, trim: true, maxlength: 80, required: true },
    /** the house: one of ours, or a name typed when it is not on the list */
    hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel", default: null },
    hostelName: { type: String, trim: true, maxlength: 80 },
    /** which of the house's own houses, where the form's house is two ("1" / "2" of הוסטל השלום); "" otherwise */
    unit: { type: String, trim: true, maxlength: 20, default: "" },
    /**
     * where the lesson takes place: in the house, or at שק״ל - and, in a form one person fills for several
     * teachers, also at "מטי" (Eden, 2026-11-23: "אצל חוסאם בטופס… או בשק״ל או מטי או בהוסטל עצמו")
     */
    place: { type: String, enum: ["hostel", "shekel", "mati"], required: true },
    note: { type: String, trim: true, maxlength: 200 },
    /** the teacher of THIS lesson, in a form one person fills for several teachers (`covers`); null: the form's own teacher */
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Person", default: null },
    /** who wrote it last */
    by: { type: String, enum: ["teacher", "staff"], required: true },
    byName: { type: String, trim: true, maxlength: 80 },
    at: { type: Date, default: Date.now },
    /**
     * The staff's word on the lesson as it is written (Eden, 2026-11-25: "לתת לשמרית ולי אפשרות לסמן… מה תקין ומה
     * לא. ואם מסמנים מה לא אז… למה"): right, or not right - and then why: it belongs to מכללה לכל's program, or
     * something else, said in words. Never shown to the teacher; cleared when the lesson itself is changed.
     */
    check: {
      state: { type: String, enum: ["ok", "bad"] },
      reason: { type: String, enum: ["college", "other"] },
      note: { type: String, trim: true, maxlength: 300 },
      by: { type: String, trim: true, maxlength: 80 },
      at: Date,
    },
  },
  { _id: true }
);

const weekPlanSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, unique: true },
    token: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    openedBy: { type: String, trim: true, maxlength: 80 },
    /**
     * The language the teacher's form opens in (Eden, 2026-11-18: the
     * teachers of הוסטל השלום read it in Arabic and can switch to Hebrew).
     * The staff's page is Hebrew either way.
     */
    lang: { type: String, enum: ["he", "ar"], default: "he" },
    /** the link's story */
    sentAt: Date,
    sentBy: { type: String, trim: true, maxlength: 80 },
    openedAt: Date,
    lastOpenedAt: Date,
    opens: { type: Number, default: 0 },
    teacherEditedAt: Date,
    submittedAt: Date,
    /** the teacher's word with the form (also: "I have no fixed lessons") */
    note: { type: String, trim: true, maxlength: 500 },
    entries: [entrySchema],
    /**
     * A form ONE person fills for several teachers (Eden, 2026-11-23: "אני רוצה
     * שחוסאם ימלא עבור כל המורים של הוסטל השלום"): the teachers it is filled
     * for - the filler among them - and the house they are the teachers of.
     * Every lesson of such a form names its teacher (`entries.teacher`).
     */
    covers: [{ type: mongoose.Schema.Types.ObjectId, ref: "Person" }],
    coversHostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel", default: null },
    /**
     * The house is more than one (Eden, 2026-11-23: "הוא יכול לבחור מעכשיו אחד מבין שני הוסטלים - הוסטל השלום 1
     * ו-הוסטל השלום 2"): the names of its houses ("1", "2"). Every lesson then belongs to one of them
     * (`entries.unit`), of `coversHostel`. A lesson written before keeps none until it is given one.
     */
    coversUnits: [{ type: String, trim: true, maxlength: 20 }],
    /**
     * What was written before and is not counted any more ("את הדברים הישנים
     * שלו לא נתייחס אליהם"): kept as it was, out of every view of the week.
     */
    aside: [entrySchema],
    asideNote: { type: String, trim: true, maxlength: 500 },
    asideAt: Date,
    asideBy: { type: String, trim: true, maxlength: 80 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WeekPlan", weekPlanSchema);
module.exports.HHMM = HHMM;
