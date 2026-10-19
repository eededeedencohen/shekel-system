/**
 * @file DiaryEntry - a line in a staff member's own diary (שמרית,
 * 2026-10-14: "יומן עם תאריכים… אם הוא אומר לי ב-15 אני טס לחו"ל, אני
 * רושמת לי: המורה טס לחו"ל"; and a checklist: "כותרת, תוכן… בוצע, לא
 * בוצע"). A note sits on a day; a task is also done or not. Owned by the
 * ACTING account - viewing as someone reads their diary.
 * @module models/DiaryEntry
 */

const mongoose = require("mongoose");
const { WORLDS, DIARY_KINDS } = require("../utils/domain");

const diaryEntrySchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    /** The staff account's id (StaffAccount) - the diary is theirs alone. */
    owner: { type: String, required: true, index: true },
    /** "2026-10-19" - a calendar day, no time zone games. */
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    kind: { type: String, enum: DIARY_KINDS, required: true, default: "note" },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, trim: true, maxlength: 4000 },
    done: { type: Boolean, default: false },
    doneAt: { type: Date },
    /** Whom it is about, when it is about someone - a teacher, a hostel. */
    about: {
      person: { type: mongoose.Schema.Types.ObjectId, ref: "Person" },
      hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel" },
    },
    createdBy: { type: String, trim: true },
  },
  { timestamps: true, collection: "diaryEntries" }
);

diaryEntrySchema.index({ world: 1, owner: 1, date: 1 });

module.exports = mongoose.model("DiaryEntry", diaryEntrySchema);
