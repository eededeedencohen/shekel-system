/**
 * @file Cycle model — a concrete run of a subject ("מחזור")
 * @module models/Cycle
 *
 * Today's CourseInstance, renamed (the _id namespace is preserved). The
 * Course middle layer is gone: `subject` is the required identity/grouping
 * key, and everything senzey lives inertly under `import.*`.
 *
 * Structure decisions (see db-remodel-plan.html):
 *  - `schedule[]` is the SINGLE source of weekly times. Enrollments point
 *    at a slot by _id (slotId) instead of copying day/times.
 *  - Room appears ONLY as ObjectId refs (schedule[].room, requiredRooms[]).
 *  - `hostel` (track membership) and `venue` (physical meeting place) are
 *    two different facts — a hostel group often meets on campus. `site` is
 *    NOT stored: it's a virtual derived from schedule rooms / venue, and an
 *    exclusivity validator keeps the derivation unambiguous.
 *  - The enrolled cohort is NOT here — cycle documents are lean and
 *    constant-size; membership lives in the enrollments collection.
 */

const mongoose = require("mongoose");
const {
  WORLDS,
  CYCLE_STATUSES,
  FUNCTIONING_LEVELS,
} = require("../utils/domain");
const { timeRangeSchema } = require("./schemas/timeRange");

const slotSchema = timeRangeSchema({
  /** Default room for this weekly slot (campus cycles). */
  room: { type: mongoose.Schema.Types.ObjectId, ref: "Room", default: null },
});

const cycleSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: [true, "מחזור חייב מקצוע"],
    },
    /** Nullable — legacy imports surface "ללא מורה". */
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Person", default: null },
    status: {
      type: String,
      // "Planned" = demand-driven, matching-views only, never joinable.
      enum: CYCLE_STATUSES,
      required: true,
      default: "Active",
    },
    startDate: { type: Date, required: [true, "תאריך התחלה הוא חובה"] },
    endDate: { type: Date, required: [true, "תאריך סיום הוא חובה"] },
    /** THE weekly schedule — 1–5 slots (private cycles: one per student). */
    schedule: [slotSchema],
    /** TRACK membership ("מכללה לכל הוסטלים" of hostel X). null = college. */
    hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel", default: null },
    /**
     * Physical meeting place when NOT a campus room: a hostel (ref, with an
     * optional in-hostel label like "סלון") or a free-text external venue.
     * Campus rooms live on schedule[].room — never here.
     */
    venue: {
      hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel" },
      label: { type: String, trim: true },
    },
    /** Matching rules — Noa sets these per cycle; ages/levels are soft. */
    matching: {
      ageMin: { type: Number, min: 0 },
      ageMax: { type: Number, min: 0 },
      functioningLevels: [{ type: String, enum: FUNCTIONING_LEVELS }],
      format: { type: String, enum: ["Group", "Private"] },
      /** Enforced at write time by the enrollment service (active+reserved < capacity). */
      capacity: { type: Number, min: 1 },
      enrollmentOpen: { type: Boolean, default: true },
      requirements: { type: String, trim: true },
      requiredRooms: [{ type: mongoose.Schema.Types.ObjectId, ref: "Room" }],
    },
    /** Senzey quarantine — display/debug only, never matched on. */
    import: {
      senzeyCourseId: { type: String, trim: true },
      senzeyName: { type: String, trim: true },
      senzeyCategory: { type: String, trim: true },
      roomLabel: { type: String, trim: true },
      unmatchedRequiredRooms: [{ type: String, trim: true }],
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

cycleSchema.index({ world: 1, status: 1 });
cycleSchema.index({ world: 1, subject: 1 });
cycleSchema.index({ world: 1, teacher: 1 });
cycleSchema.index({ world: 1, hostel: 1 });
cycleSchema.index(
  { world: 1, "import.senzeyCourseId": 1 },
  { unique: true, partialFilterExpression: { "import.senzeyCourseId": { $exists: true } } }
);

cycleSchema.pre("validate", function (next) {
  if (this.startDate && this.endDate && this.startDate > this.endDate) {
    this.invalidate("endDate", "תאריך הסיום חייב להיות מאוחר יותר מתאריך ההתחלה");
  }
  // site is derived, so the derivation must be unambiguous: a cycle may not
  // have both campus rooms on slots AND a non-campus venue.
  const hasCampusRoom = (this.schedule || []).some((s) => s.room);
  const hasVenue = !!(this.venue && (this.venue.hostel || this.venue.label));
  if (hasCampusRoom && hasVenue) {
    this.invalidate("venue", "מחזור לא יכול לשבת גם בחדר קמפוס וגם ב-venue חיצוני/הוסטל");
  }
  next();
});

/** Derived (never stored): campus | hostel | external | null (unknown). */
cycleSchema.virtual("site").get(function () {
  if ((this.schedule || []).some((s) => s.room)) return "campus";
  if (this.venue?.hostel) return "hostel";
  if (this.venue?.label) return "external";
  return null;
});

/** A cycle joins matching views only once Noa classified it. */
cycleSchema.virtual("isClassified").get(function () {
  const m = this.matching || {};
  return (
    m.capacity != null &&
    m.ageMin != null &&
    m.ageMax != null &&
    Array.isArray(m.functioningLevels) &&
    m.functioningLevels.length > 0
  );
});

module.exports = mongoose.model("Cycle", cycleSchema);
