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
    /** where the lesson takes place: in the house, or at שק״ל */
    place: { type: String, enum: ["hostel", "shekel"], required: true },
    note: { type: String, trim: true, maxlength: 200 },
    /** who wrote it last */
    by: { type: String, enum: ["teacher", "staff"], required: true },
    byName: { type: String, trim: true, maxlength: 80 },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const weekPlanSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, unique: true },
    token: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    openedBy: { type: String, trim: true, maxlength: 80 },
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
  },
  { timestamps: true }
);

module.exports = mongoose.model("WeekPlan", weekPlanSchema);
module.exports.HHMM = HHMM;
