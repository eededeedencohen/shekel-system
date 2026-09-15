/**
 * @file Lesson model — a dated occurrence of a cycle + its attendance ledger
 * @module models/Lesson
 *
 * Attendance stays EMBEDDED by design: it is written together (one grid
 * save), read together (one grid render) and bounded by the cohort size.
 * The old "student history = full scan" problem is dead without extraction:
 * the multikey {'attendance.student', date} index makes per-student history
 * one indexed, paginated read.
 *
 * Hardened invariants — all at the schema layer:
 *  - `date` is normalized to UTC midnight by a PATH SETTER, which (unlike a
 *    pre-validate hook) also runs on findOneAndUpdate/$set — so the unique
 *    partial index {cycle,date} on source:'live' holds from EVERY write path.
 *  - `source` (live | archive) is required with a default — no missing-field
 *    ambiguity, and the list filter {source:'live'} exactly matches the
 *    index predicate.
 *  - Archive docs (the pre-overhaul import; may hold retired statuses that
 *    must never re-validate) are IMMUTABLE below the service layer: save is
 *    rejected, and every query-update/delete path is silently scoped to
 *    non-archive docs.
 *  - No student may appear twice in one lesson's attendance (the embed
 *    can't carry a unique index — a validator fills that role).
 */

const mongoose = require("mongoose");
const { WORLDS, ATTENDANCE_STATUSES } = require("../utils/domain");

/** Any date-ish value → Date at UTC midnight of its UTC day. */
function utcMidnight(v) {
  if (v == null || v === "") return v;
  const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00.000Z`) : new Date(v);
  if (Number.isNaN(d.getTime())) return v; // let required/cast validation complain
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const lessonSchema = new mongoose.Schema(
  {
    cycle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Cycle",
      required: [true, "שיעור חייב מחזור"],
    },
    date: {
      type: Date,
      required: [true, "תאריך השיעור הוא חובה"],
      set: utcMidnight, // runs on saves AND on update-query $set
    },
    /** Per-session override of cycle.teacher. */
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Person", default: null },
    /** Per-session override of the slot's room. */
    room: { type: mongoose.Schema.Types.ObjectId, ref: "Room", default: null },
    source: {
      type: String,
      enum: ["live", "archive"],
      required: true,
      default: "live",
    },
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    attendance: [
      {
        student: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Person",
          required: [true, "רשומת נוכחות חייבת סטודנט"],
        },
        status: {
          type: String,
          enum: { values: ATTENDANCE_STATUSES, message: "{VALUE} אינו סטטוס נוכחות חוקי" },
          required: [true, "חובה לציין סטטוס נוכחות"],
        },
        note: { type: String, trim: true },
        progressRating: { type: Number, min: 1, max: 10 },
        /** Ad-hoc/guest participant (inverted from the old isOriginalGroupMember). */
        isGuest: { type: Boolean, default: false },
      },
    ],
  },
  { timestamps: true }
);

// One LIVE lesson per (cycle, day) — enforceable because the date setter
// normalizes on every path.
lessonSchema.index(
  { cycle: 1, date: 1 },
  { unique: true, partialFilterExpression: { source: "live" } }
);
lessonSchema.index({ cycle: 1, source: 1, date: 1 });
lessonSchema.index({ "attendance.student": 1, date: -1 });
lessonSchema.index({ world: 1, date: 1 });

/** No student twice in one ledger (the embed's stand-in for a unique index). */
lessonSchema.pre("validate", function (next) {
  const seen = new Set();
  for (const r of this.attendance || []) {
    const k = String(r.student);
    if (seen.has(k)) {
      return next(new Error("אותו סטודנט מופיע פעמיים ברשימת הנוכחות"));
    }
    seen.add(k);
  }
  next();
});

/** Archive docs refuse document saves… */
lessonSchema.pre("save", function (next) {
  if (!this.isNew && this.source === "archive") {
    return next(new Error("שיעור ארכיוני — לקריאה בלבד"));
  }
  next();
});

/** …and every query-update/delete path is scoped away from the archive, so
 *  no handler can touch it even by accident. */
function excludeArchive(next) {
  const q = this.getQuery() || {};
  if (q.source === undefined) this.where({ source: { $ne: "archive" } });
  else if (q.source === "archive") return next(new Error("שיעור ארכיוני — לקריאה בלבד"));
  next();
}
lessonSchema.pre("updateOne", excludeArchive);
lessonSchema.pre("updateMany", excludeArchive);
lessonSchema.pre("findOneAndUpdate", excludeArchive);
lessonSchema.pre("findOneAndDelete", excludeArchive);
lessonSchema.pre("deleteOne", { document: false, query: true }, excludeArchive);
lessonSchema.pre("deleteMany", excludeArchive);

module.exports = mongoose.model("Lesson", lessonSchema);
